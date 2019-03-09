/* jshint node: true */
'use strict';

var BasePlugin = require('ember-cli-deploy-plugin');
var RSVP = require('rsvp');
var fs = require('fs');
var path = require('path');
var template = require('lodash/string/template');
var minimatch = require('minimatch');
var request = require('request-promise');

const metaContent = '<meta name="honeybadger"/>';
const sourceMapApiURL = 'https://api.honeybadger.io/v1/source_maps';
const deploymentApiURL = 'https://api.honeybadger.io/v1/deploys';

module.exports = {
  name: 'ember-cli-deploy-honeybadger',

  createDeployPlugin: function(options) {
    var DeployPlugin = BasePlugin.extend({
      name: options.name,
      runAfter:  ['revision-data'],
      requiredConfig: ['apiKey', 'minifiedPrependUrl'],

      defaultConfig: {
        projectName: function(context) {
          return context.project.pkg.name;
        },
        revisionKey: function(context) {
          return context.revisionData && context.revisionData.revisionKey;
        },
        distFiles: function(context) {
          return context.distFiles;
        },
        distDir: function(context) {
          return context.distDir;
        },
        environment: function(context) {
          var honeybadgerConfig = context.config.honeybadger.honeybadgerConfig;
          var buildConfig = context.config.build;
          var environment = honeybadgerConfig ? honeybadgerConfig.environment : false;
          return environment || buildConfig.environment || 'production';
        },
        additionalFiles: [],
        honeybadgerFileURI: '//js.honeybadger.io/v0.5/honeybadger.min.js'
      },

      prepare: function(context) {
        // render honeybadger snippet with fulfilled config
        var htmlSnippetPath = path.join(__dirname, 'addon', 'honeybadger.html');
        var htmlContent = fs.readFileSync(htmlSnippetPath, 'utf-8');

        var honeybadgerSnippet = template(htmlContent)({
          apiKey: this.readConfig('apiKey'),
          environment: this.readConfig('environment'),
          revision: this.readConfig('revisionKey'),
          jsFile: this.readConfig('honeybadgerFileURI')
        });

        // replace honeybadger metatag with honeybadger snippet in index.html
        var indexPath = path.join(context.distDir, "index.html");
        var index = fs.readFileSync(indexPath, 'utf8');
        index = index.replace(metaContent, honeybadgerSnippet);
        fs.writeFileSync(indexPath, index);
      },

      // upload files in didPrepare before ember-cli-deploy-gzip and related
      // plugins gzip our files
      didPrepare: function(context) {
        var distFiles = this.readConfig('distFiles');
        var projectName = this.readConfig('projectName');
        var additionalFiles = this.readConfig('additionalFiles');

        var filePattern = projectName + ',vendor';

        if(additionalFiles.length) {
          filePattern += ',' + additionalFiles.join(',');
        }

        // fetch vendor and project-specific js and map
        var projectFileJs = distFiles.filter(minimatch.filter('**/{' + filePattern + '}*.js', {
          matchBase: true
        }));
        var projectFileMap = distFiles.filter(minimatch.filter('**/{' + filePattern + '}*.map', {
          matchBase: true
        }));

        var promiseArray = [];

        for(var i = 0; i < projectFileJs.length; i++) {
          var mapFilePath = path.join(this.readConfig('distDir'), projectFileMap[i]);
          var jsFilePath = path.join(this.readConfig('distDir'), projectFileJs[i]);
          var minifiedPrependUrl = this.readConfig('minifiedPrependUrl');
          if (typeof minifiedPrependUrl === 'function') {
            minifiedPrependUrl = minifiedPrependUrl(context);
          }
          [].concat(minifiedPrependUrl).forEach((url)=> {
            var formData = {
              name: url + projectFileJs[i],
              api_key: this.readConfig('apiKey'),
              revision: this.readConfig('revisionKey'),
              minified_url: url + projectFileJs[i],
              source_map: fs.createReadStream(mapFilePath),
              minified_file: fs.createReadStream(jsFilePath)
            };

            promiseArray.push(request({
              uri: sourceMapApiURL,
              method: 'POST',
              formData: formData
            }));
          });
        };

        this.log('Uploading files...', {verbose: true});
        return RSVP.all(promiseArray);
      },

      didDeploy: function() {
        var deploy = {
          environment: this.readConfig('environment'),
          revision: this.readConfig('revisionKey')
        };

        var username = this.readConfig('username');
        if(username){
          deploy.username = username;
        }

        this.log('Registering deployment...', {verbose: true});
        return request({
          method: 'POST',
          uri: deploymentApiURL,
          form: {
            api_key: this.readConfig('apiKey'),
            deploy: deploy
          }
        });
      }
    });

    return new DeployPlugin();
  },

  contentFor: function(type) {
    if (type === 'head') {
      return metaContent;
    }
  }
};
