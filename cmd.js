#!/usr/bin/env node

var util = require('util');
var path = require('path');
var cp = require('child_process');
var fs = require('graceful-fs');

var checkSyntax = require('syntax-error');
var npm = require('npm');
var detective = require('detective');
var resolve = require('resolve');
var semver = require('semver');
require('colors');
var async = require('async');

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

var child = null;
var dependencies;

var toInstall = [];
var visited = [];
var watching = [];

function log() {
    var msg = util.format.apply(util, arguments);
    console.log('['.white + 'autobahn'.magenta + ']'.white, msg);
}

function isCore(pkg) {
    // check for domain explicitly since it's not (yet) part of resolve.isCore
    return (resolve.isCore(pkg) || pkg === 'domain');
}

function installPackage(pkg, callback) {
    // avoid core packages and packages already scheduled to be installed
    if (isCore(pkg) || toInstall.indexOf(pkg) !== -1) return callback(null);

    // test and see if the package can be resolved
    try {
        var resolved = resolve.sync(pkg, {
            basedir: process.cwd()
        });
    } catch (e) {
        toInstall.push(pkg);
        return callback(null);
    }
    if (!dependencies) return callback(null);

    var filePath = path.resolve(
        npm.prefix, 'node_modules', pkg, 'package.json'
    );
    fs.readFile(filePath, 'utf8', function(err, packageJson) {
        if (err) return callback(err);

        var actual = JSON.parse(packageJson).version;
        var expected = dependencies[pkg];

        // validRange rewrites the range and returns null if it's not a valid
        // range like with depending on github project or similar
        if (actual && expected && semver.validRange(expected) &&
                !semver.satisfies(actual, expected)) {
            toInstall.push(pkg);
        }
        callback(null);
    });
}

function visit(filename, basedir, callback) {
    filename = resolve.sync(filename, {
        basedir: basedir
    });

    if (visited.indexOf(filename) !== -1) return callback();
    visited.push(filename);

    fs.readFile(filename, 'utf8', function(err, str) {
        if (err) return callback(err);

        // remove hashbang
        str = str.replace(/^#!.*\n/, '');
        // put str in function (to allow return statement in a module)
        str = '(function() {\n' + str + '\n})();';
        var err = checkSyntax(str, filename);
        if (err) return callback(err);

        // avoid json-dependencies
        var dependencies = detective(str).filter(function(dependency) {
            return !dependency.match(/\.json$/);
        });

        async.forEach(dependencies, function(dependency, done) {
            if (dependency[0] === '.') {
                var basedir = path.dirname(filename);
                visit(dependency, basedir, done);
            } else {
                installPackage(dependency, done);
            }
        }, callback);
    });
}

function init(callback) {
    dependencies = {};
    async.series([
        function loadNpm(done) {
            npm.load(done);
        },
        function parsePackageJson(done) {
            if (opts.save) {
                npm.config.set('save', true);
            }

            var filePath = path.resolve(npm.prefix, 'package.json');
            fs.readFile(filePath, 'utf8', function(err, packageJson) {
                if (err) {
                    done(err.code === 'ENOENT' ? null : err);
                    return;
                }

                packageJson = JSON.parse(packageJson);

                if (packageJson.dependencies) {
                    var keys = Object.keys(packageJson.dependencies);
                    keys.forEach(function(key) {
                        dependencies[key] = packageJson.dependencies[key];
                    });
                }

                if (packageJson.devDependencies) {
                    var keys = Object.keys(packageJson.devDependencies)
                    keys.forEach(function(key) {
                        dependencies[key] = packageJson.devDependencies[key];
                    });
                }
                done(null);
            });
        }],
        callback
    );
}

var loading = false;
var onexit = null;

function install(callback) {
    toInstall.length = 0;
    visited.length = 0;

    visit(args[0], process.cwd(), function(err) {
        if (err) return callback(err);

        if (toInstall.length === 0) {
            callback();
            return;
        }

        toInstall = toInstall.map(function(pkg) {
            return dependencies[pkg]? pkg + '@' + dependencies[pkg] : pkg;
        });

        npm.commands.install(toInstall, callback);
    });
}

function fork() {
    log('(re)starting');
    child = cp.spawn('node', args, { stdio: 'inherit' });
    child.once('exit', function() {
        child = null;
        onexit.apply(null, arguments);
    });

    onexit = function(code, signal) {
        log('script exited, exit code: %s, signal: %s', code, signal);
        if (!opts.watch) process.exit();
    }

    loading = false;
}

function killChild(callback) {
    if (!child) return callback();

    onexit = function() {
        log('script exited, to restart it soon');
        callback();
    }
    child.kill();
}

function watch() {
    if (loading) return;
    loading = true;

    async.series([
            killChild, init, install
        ],
        function(err) {
            visited.forEach(function(file) {
                if (watching.indexOf(file) === -1) {
                    console.log('watching %s', file);
                    watching.push(file);
                    fs.watchFile(file, { interval: 500 }, function() {
                        watching.forEach(fs.unwatchFile);
                        watching.length = 0;
                        watch();
                    });
                }
            });
            if (err) {
                // deal with error by writing it out and stop execution - so
                // the watch will still be there but no fork will be unleached
                console.error(err);
                loading = false;
                return;
            }

            fork();
        }
    );
}

if (opts.watch) {
    watch();
} else {
    async.series([
        init, install
    ],
    function(err) {
        if (err) throw err;
        fork();
    });
}
