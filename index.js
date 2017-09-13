/* jshint node: true */
'use strict';

var RSVP = require('rsvp');
var fs = require('fs');
var path = require('path');
var merge = require('lodash/object/merge');
var template = require('lodash/string/template');
var minimatch = require('minimatch');
var FormData = require('form-data');

var BasePlugin = require('ember-cli-deploy-plugin');

module.exports = {
  name: 'airpr-honeybadger',

  createDeployPlugin: function(options) {
    var DeployPlugin = BasePlugin.extend({
      name: "honeybadger",

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
        enabled: function(context) {
          var honeybadgerConfig = context.config.honeybadger.honeybadgerConfig;
          var enabled = honeybadgerConfig ? honeybadgerConfig.enabled : true;
          return !(enabled === false);
        },
        captureUncaught: function(context) {
          var honeybadgerConfig = context.config.honeybadger.honeybadgerConfig;
          var captureUncaught = honeybadgerConfig ? honeybadgerConfig.captureUncaught : true;
          return !(captureUncaught === false);
        },
        integrateHoneybadger: true,
        additionalFiles: [],
        honeybadgerFileURI: '//js.honeybadger.io/v0.5/honeybadger.min.js'
      },
      requiredConfig: ['accessToken', 'accessServerToken', 'minifiedPrependUrl'],

      willUpload: function(context) {
        if(this.readConfig('integrateHoneybadger')) {
          // setup honeybadgerConfig
          var honeybadgerConfig = {
            accessToken: this.readConfig('accessToken'),
            enabled: this.readConfig('enabled'),
            captureUncaught: this.readConfig('captureUncaught'),
            environment: this.readConfig('environment'),
            codeVersion: this.readConfig('revisionKey'),
            payload: {
              client: {
                javascript: {
                  source_map_enabled: true,
                  code_version: this.readConfig('revisionKey'),
                  guess_uncaught_frames: true
                }
              }
            }
          };

          var honeybadgerFileURI = this.readConfig('honeybadgerFileURI');

          // render honeybadger snippet with fulfilled config
          var htmlSnippetPath = path.join(__dirname, 'addon', 'honeybadger.html');
          var htmlContent = fs.readFileSync(htmlSnippetPath, 'utf-8');

          var honeybadgerSnippet = template(htmlContent)({
            apiKey: honeybadgerConfig.accessToken,
            environment: honeybadgerConfig.environment,
            revision: honeybadgerConfig.codeVersion,
            jsFile: honeybadgerFileURI
          });

          // replace honeybadger metatag with honeybadger snippet in index.html
          var indexPath = path.join(context.distDir, "index.html");
          var index = fs.readFileSync(indexPath, 'utf8');
          index = index.replace('<meta name="honeybadger"/>', honeybadgerSnippet);
          fs.writeFileSync(indexPath, index);
        }
      },

      upload: function(context) {
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
        var accessServerToken = this.readConfig('accessServerToken');
        var revisionKey = this.readConfig('revisionKey');

        for(var i = 0; i < projectFileJs.length; i++) {
          // upload map to honeybadger using form-data

          var mapFilePath = path.join(this.readConfig('distDir'), projectFileMap[i]);
          var jsFilePath = path.join(this.readConfig('distDir'), projectFileJs[i]);
          var minifiedPrependUrl = this.readConfig('minifiedPrependUrl');
          if (typeof minifiedPrependUrl === 'function') {
            minifiedPrependUrl = minifiedPrependUrl(context);
          }
          [].concat(minifiedPrependUrl).forEach(function(url) {
            var formData = new FormData();
            formData.append('api_key', accessServerToken);
            formData.append('revision', revisionKey);
            formData.append('minified_url', url + projectFileJs[i]);
            var fileSize = fs.statSync(mapFilePath)['size'];
            formData.append(
              'source_map',
              fs.createReadStream(mapFilePath),
              { knownLength: fileSize }
            );

            fileSize = fs.statSync(jsFilePath)['size'];
            formData.append(
              'minified_file',
              fs.createReadStream(jsFilePath),
              { knownLength: fileSize }
            );
            var promise = new RSVP.Promise(function(resolve, reject) {
              formData.submit('https://api.honeybadger.io/v1/source_maps', function(error, result) {
                if(error) {
                  reject(error);
                }
                result.resume();

                result.on('end', function() {
                  resolve();
                });
              });
            });
            promiseArray.push(promise);
          });
        };
        return RSVP.all(promiseArray);
      }
    });

    return new DeployPlugin();
  },

  contentFor: function(type) {
    if (type === 'head') {
      return '<meta name="honeybadger"/>';
    }
  }
};
