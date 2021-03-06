//
// Ok boys and girls, here's how this whole oauth deal goes down.
//
// First, clients needs to get a `request token`, which is a temporary
// access token that identifies subsequent requests.  Use
// `OAuth.getRequestToken(path, callbackUrl, callback)` to accomplish
// this.  The URL to do this will be stated by the OAuth provider as
// the "Temporary Credentials Request" url.
//
// One we have that request token we need to get user authorization,
// which is done by redirecting the user to the relevant URL using
// the aforementioned request token.  See individual OAuth provider
// docs for details on how to craft this URL (the spec calls it the
// "Resource Own Authorization URI").
//
// When that auth process is finished the user is sent back to the
// callback URL (or is giving an OOB token if callback was `'oob'`).
// This callback contains, in the query args, two fields:
// `oauth_token`, which will be the same as was provided to the auth
// URL the user visited, and `oauth_verifier`, which we use to get
// a real access token.
//
// So then, armed with our new `oauth_verifier`, we just have one
// more call to make, to the token endpoint (the "Token Request URI").
// To this call we pass along all of our credentials, as well as our
// temporary token and the `oauth_verifier`.  In the response a new
// `oauth_token`, as well as an `oauth_token_secret`.  Armed with
// these, we may now sign requests properly and use the OAuth
// credentials with the API.
//
// Some Notes:
//
// This library does header-based OAuth using HMAC-SHA1
//

// TODO - support parameters in the body

var Mode = {
  header: 0x01,
  body: 0x02
};

var uuid = require('./uuid'),
    querystring = require('querystring'),
    crypto = require('crypto'),
    url = require('url'),
    http = require('http'),
    https = require('https');

// OAuth requires escaping of a broader set of characters than
// querystring, so we have to roll our own.
var oauthParamEscape = function(s) {
  return encodeURIComponent(s)
         .replace('*', '%2A')
         .replace('!', '%21')
         .replace('\'', '%27')
         .replace('(', '%28')
         .replace(')', '%29');
};

var baseString = function(method, url, params) {
  var urlSplit = url.split('?');

  var res = method.toUpperCase() + '&';
  res += querystring.escape(urlSplit[0]) + '&';

  // Parse the url params
  var urlParams = querystring.parse(urlSplit[1]);

  // Grab params from the params object and the url
  var ps = [];
  for (var i in params) if (params.hasOwnProperty(i))
    ps.push(i);
  for (var i in urlParams) if (urlParams.hasOwnProperty(i))
    ps.push(i);

  // Sort the params alphabetically
  ps.sort();

  // Add the params to the string
  var parts = [];
  for (var i=0; i<ps.length; i++) {
    var p = '';
    p += oauthParamEscape(ps[i]);
    p += '%3D';
    p += oauthParamEscape(params[ps[i]] || urlParams[ps[i]]);
    parts.push(p);
  }
  res += parts.join('%26');

  return res;
};

var genSig = function(method, url, params, client, token_secret) {

  // Generate the key
  var key = querystring.escape(client.secret) +
            '&' +
            querystring.escape(token_secret || '');

  // HMAC-SHA1
  if (client.crypto == 'HMAC-SHA1') {
    // Do the hmac
    var hmac = crypto.createHmac('sha1', key);
    hmac.update(baseString(method, url, params));
    var res = hmac.digest('base64');
  }

  return res;
};

var nonce = uuid.uuid4;
var timestamp = function() { return Math.floor(new Date().getTime() / 1000) };

var OAuth = function(key, secret, api, crypto) {
  this.key = key;
  this.secret = secret;

  var parsed = url.parse(api);
  // Pull secure from the protocol's scheme
  this.secure = parsed.protocol == 'https:';
  // Force API to conform with the base uri specification (3.4.1.2)
  this.api = parsed.hostname.toLowerCase();
  // Attach the port if needed
  if (parsed.port) {
    if (secure && parsed.port != 443)
      parsed.hostname += ':' + parsed.port;
    else if (!secure && parsed.port != 80)
      parsed.hostname += ':' + parsed.port;
  }

  this.crypto = crypto || 'HMAC-SHA1';

  // Validate crypto
  if (this.crypto != 'HMAC-SHA1') throw new Error('Crypto type ' + this.crypto +
                                                  ' is not supported');
};
OAuth.prototype = {};

// Clone of the regular http request functionality
OAuth.prototype.request = function(options, callback) {

  // Get extra stuff out of options
  var token = options.token;
  delete options.token;
  var oauthCallback = options.callback;
  delete options.callback;

  // Ensure headers is in options, and default Content-Length to 0 for
  // dumb providers like LinkedIn
  if (!options.headers) options.headers = {'Content-Length': 0};
  else if (!options.headers.hasOwnProperty('Content-Length'))
    options.headers['Content-Length'] = 0;

  // Default the port
  if (!options.port) options.port = this.secure ? 443 : 80;

  // Set the host explicitly
  options.host = this.api;

  // Create the auth oauth params
  var params = {
    oauth_version: '1.0',
    oauth_consumer_key: this.key,
    oauth_signature_method: this.crypto,
    oauth_timestamp: timestamp(),
    oauth_nonce: nonce(),
  }

  if (oauthCallback) params.oauth_callback = querystring.escape(oauthCallback);

  // Add the verifier to the params if it exists in the token
  if (token && token.verifier)
    params.oauth_verifier = token.verifier;
  // Add the token to the params if it's present
  if (token && token.token)
    params.oauth_token = token.token;

  // Build the sig params
  var sigParams = {};
  for (var i in params) if (params.hasOwnProperty(i))
    sigParams[i] = params[i];
  if (options.postData) {
    var b = querystring.parse(options.postData);
    for (var i in b) if (b.hasOwnProperty(i))
      // We have to re-escape them because we actually WANT the escaped
      // forms.  OAuth is dumb.
      sigParams[oauthParamEscape(i)] = oauthParamEscape(b[i]);

    delete options.postData;
  }

  // Generate the signature
  var uri = (this.secure ? 'https' : 'http') + '://' + this.api.toLowerCase() + options.path;
  params.oauth_signature = querystring.escape(genSig(options.method, uri, sigParams, this, token && token.secret));

  // Build the OAuth auth header from the signature
  var authHeader = 'OAuth ';
  var bits = [];
  for (var i in params) if (params.hasOwnProperty(i))
    bits.push(i + '="' + params[i] + '"');
  authHeader += bits.join(', ');

  // Set the auth header
  options.headers.Authorization = authHeader;

  // Pass on through to node's built in behavior
  return (this.secure ? https : http).request(options, callback);
};

// Fetches a request token
OAuth.prototype.requestToken = function(path, callbackUrl, callback) {

  var self = this;

  // Default to OOB mode if no callback was supplied
  callbackUrl = callbackUrl || 'oob';

  // Create the request options
  var options = {
    method: 'POST',
    path: path,
    callback: callbackUrl
  };

  var req = self.request(options, function(res) {
    var data = '';

    res.on('data', function(c) { data += c });
    res.on('end', function() { finish() });
    res.on('close', function(err) {
      console.log('Error receiving OAuth request token from ' + self.api);
      console.log(err.stack);
      console.log('');
      callback(err);
    });

    var finish = function() {
      // Bail on errors
      if (res.statusCode != 200) {
        console.log('Error fetching OAuth request token');
        console.log(data);
        console.log('');

        return callback(new Error(data));
      }

      // Parse data
      data = querystring.parse(data);

      // If the callback was bad, bail
      if (!data.oauth_callback_confirmed) return callback(new Error('Bad callback'));

      // Otherwise, return the token
      callback(undefined, new Token(data.oauth_token, data.oauth_token_secret));
    };
  })
  req.on('error', function(err) {
    console.log('Error accessing OAuth request token from ' + self.api);
    console.log(err.stack);
    console.log('');
    callback(err);
  });
  req.end();
};

// Fetches an access token
OAuth.prototype.accessToken = function(path, token, callback) {

  // Now that we have a verifier, we need to make one final request to
  // Twitter to get a real token.
  var options = {
    method: 'POST',
    path: path,
    token: token
  };
  var req = this.request(options, function(res) {

    var data = '';

    res.on('data', function(c) { data += c });
    res.on('end', function() { finish() });
    res.on('close', function(err) {
      console.log('Error receiving OAuth request token from ' + self.api);
      console.log(err.stack);
      console.log('');
      callback(err);
    });

    var finish = function() {
      data = querystring.parse(data);

      // Handle errors
      if (res.statusCode != 200) {
        console.log('Error fetching OAuth access token');
        console.log(data);
        console.log('');

        return callback(new Error(data));
      }

      // Pass the token on down the line
      var token = new Token(data.oauth_token, data.oauth_token_secret);
      callback(undefined, token);
    };
  });
  req.end();
  req.on('error', function(err) {
    console.log('Error starting authentication with Twitter');
    console.log(err.message);
    console.log('');
    callback(err);
  });
};

OAuth.prototype.authToken = function(req) {

};

var Token = function(token, secret) {
  this.token = token; this.secret = secret;
};
Token.prototype = {};

// Exports
exports.OAuth = OAuth;
exports.Token = Token;
exports.Mode = Mode

