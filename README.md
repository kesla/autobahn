autobahn
========

Run `autobahn` instead of `node` and get all dependencies automatically installed for you.

installation
------------

```
npm install -g autobahn
```

usage/demo
----------

Let's assume that you have a empty folder with a simple file in it:

```js
  // simple .js
  var request = require('request');
  request('http://example.com').pipe(process.stdout);
```

Running `autobahn simple.js` will first install request and then run simple.js

See `autobahn -h` for more usage info.
