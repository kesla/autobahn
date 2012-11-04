#!/usr/bin/env node

var path = require('path');

var usage = [
    'Use autobahn instead of node and get all dependencies automatically installed',
    'Usage: autobahn [options] script [arguments]',
    '',
    'Options:',
    '  -s, --save\tSave installed dependencies to package.json',
    '  -w, --watch\tWatch the required files and restart when a file changes',
    '  -h, --help\tYou are looking at it.'
].join('\n');

var opts = {
    watch: false,
    save: false
};
var args = process.argv.slice(2);
var program;

var arg;
while (arg = args.shift()) {
    if (arg === '--watch' || arg === '-w') {
        opts.watch = true;
    } else if (arg === '--save' || arg === '-s') {
        opts.save = true;
    } else if (arg === '--help' || arg === '-h') {
        console.log(usage);
        return;
    } else {
        args.unshift(path.resolve(arg));
        break;
    }
}

if (args.length === 0) {
    return console.log(usage);
}

var cp = require('child_process');
var npm = require('npm');
var fs = require('graceful-fs');
var detective = require('detective');
var resolve = require('resolve');
require('colors');
var script;

var toInstall = [];
var visited = [];
var watching = [];

var util = require('util');

function log() {
    var msg = util.format.apply(util, arguments);
    console.log('['.white + 'autobahn'.magenta + ']'.white, msg);
}

function installPackage(pkg) {
    if (resolve.isCore(pkg)) return;

    try {
        resolve.sync(pkg, {
            basedir: process.cwd()
        });
    } catch (e) {
        if (toInstall.indexOf(pkg) === -1) toInstall.push(pkg);
    }
}

function visit(file, basedir, callback) {
    file = resolve.sync(file, {
        basedir: basedir
    });

    if (visited.indexOf(file) !== -1) return callback();
    visited.push(file);

    fs.readFile(file, 'utf8', function(err, str) {
        if (err) return callback(err);

        // remove hashbang
        str = str.replace(/^#!.*\n/, '');
        // put str in function (to allow return statement in a module)
        str = '(function() {\n' + str + '\n})();';

        var dependencies = detective(str);
        var i = dependencies.length;

        if (i === 0) {
            return callback();
        }

        function done() {
            i--;
            if (i === 0) return callback();
        }

        dependencies.forEach(function(dependency) {
            if (dependency[0] === '.') {
                var basedir = path.dirname(file);
                visit(dependency, basedir, done);
            } else {
                installPackage(dependency);
                done();
            }
        });
    });
}

function init(callback) {
    npm.load(function(err) {
        if (err) return callback(err);

        if (opts.save) {
            npm.config.set('save', true);
        }

        callback();
    });
}

var loading = false;
var onexit = null;

function install(callback) {
    toInstall.length = 0;
    visited.length = 0;

    visit(args[0], process.cwd(), function(err) {
        if (err) throw err;

        if (toInstall.length === 0) {
            callback();
            return;
        }

        npm.commands.install(toInstall, callback);
    });
}

function fork() {
    log('(re)starting');
    script = cp.spawn('node', args, { stdio: 'inherit' });
    script.once('exit', function() {
        script = null;
        onexit.apply(null, arguments);
    });

    onexit = function(code, signal) {
        log('script exited, exit code: %s, signal: %s', code, signal);
    }

    loading = false;
}

function watch() {
    if (script) {
        onexit = function() {
            log('script exited, to restart it later');
            watch();
        }
        script.kill();
        return;
    }

    if (loading) return;
    loading = true;

    install(function(err) {
        if (err) throw err;

        fork();

        visited.forEach(function(file) {
            if (watching.indexOf(file) === -1) {
                watching.push(file);
                fs.watchFile(file, { interval: 500 }, function() {
                    watching.forEach(fs.unwatchFile);
                    watching.length = 0;
                    init(function(err) {
                        if (err) throw err;

                        watch();
                    });
                });
            }
        });
    });
}

init(function(err) {
    if (err) throw err;

    if (opts.watch) {
        return watch();
    }

    install(function(err) {
        if (err) throw err;

        fork();
    });
});
