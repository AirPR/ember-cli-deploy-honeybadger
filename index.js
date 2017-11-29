/* jshint node: true */
'use strict';

var RSVP = require('rsvp');
var fs = require('fs');
var path = require('path');
var merge = require('lodash/object/merge');
var template = require('lodash/string/template');
var minimatch = require('minimatch');
var FormData = require('form-data');
var exec = require('child_process').exec;
var zlib = require('zlib');

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
        gzippedFiles: function(context) {
          return context.gzippedFiles || []; // e.g. from ember-cli-deploy-gzip
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

      _isFileGzipped(filePath) {
        var gzippedFiles = this.readConfig('gzippedFiles');
        return gzippedFiles.indexOf(filePath.replace("tmp/deploy-dist/", "")) >= 0;
      },

      _unzipPath(filePath){
        var newPath = filePath + ".unzipped";
        var readStream = fs.createReadStream(filePath);
        var writeStream = fs.createWriteStream(newPath);

        readStream
          .pipe(zlib.createGunzip())
          .pipe(writeStream);
        return newPath;
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
        var accessToken = this.readConfig('accessToken');
        var revisionKey = this.readConfig('revisionKey');

        for(var i = 0; i < projectFileJs.length; i++) {
          // upload map to honeybadger using form-data

          var mapFilePath = path.join(this.readConfig('distDir'), projectFileMap[i]);
          var jsFilePath = path.join(this.readConfig('distDir'), projectFileJs[i]);
          var minifiedPrependUrl = this.readConfig('minifiedPrependUrl');
          if (typeof minifiedPrependUrl === 'function') {
            minifiedPrependUrl = minifiedPrependUrl(context);
          }
          [].concat(minifiedPrependUrl).forEach((url)=> {

            if(this._isFileGzipped(mapFilePath)){
              mapFilePath = this._unzipPath(mapFilePath);
            }

            if(this._isFileGzipped(jsFilePath)){
              jsFilePath = this._unzipPath(jsFilePath);
            }

            var curlArgs = ['https://api.honeybadger.io/v1/source_maps',
                            '-F api_key=' + accessToken,
                            '-F revision=' + revisionKey,
                            '-F minified_url=' + url + projectFileJs[i],
                            '-F source_map=@' + mapFilePath,
                            '-F minified_file=@' + jsFilePath].join(" ");
            var promise = new RSVP.Promise(function(resolve, reject) {
              exec('curl ' + curlArgs, function (error, stdout, stderr) {
                if (error !== null) {
                  reject(error);
                }else{
                  resolve();
                }
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
