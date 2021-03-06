var db = require('./../db'),
    models = require('./../models'),
    _email = require('./../email'),
    gravatar = require('./../util/gravatar'),
    presence = require('./../presence'),
    templating = require('./../templating'),
    crypto = require('crypto');

var pwCharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';

var emailDelays = {};
var emailDelayIntervals = {};

// Utility functions

var hashPassword = function(password, email) {
  return crypto.createHash('sha256')
           .update(password + email.toLowerCase())
           .digest('hex').toUpperCase();
};

var createPassword = function(email, exists) {
  var pwRaw = '';
  for (var i=0; i<6; i++)
    pwRaw += pwCharacters[Math.floor(Math.random() * pwCharacters.length)];

  // Send an email to the user
  if (!exists)
    _email.send('New Account', email, 'Welcome to Hipsell',
      templating['email/signup'].render({password: pwRaw}));
  else
    _email.send('Password Reset', email, 'Password Reset',
      templating['email/newpw'].render({password: pwRaw}));

  // Only store the hashed form
  return hashPassword(pwRaw, email);
};

// Callback(error, badPw, obj)
var authUser = function(email, password, callback) {
  db.queryOne(models.Auth, {email: email.toLowerCase()}, function(err, obj) {

    // Handle failure gracefully
    if (err) return callback('Database Error');

    // If the object doesn't exist, neither does the user
    if (!obj) return callback(undefined, false, null);

    // If the password's don't match, it's a bad auth
    if (obj.password != password) return callback(undefined, true, obj);

    // Otherwise, we have success
    return callback(undefined, false, obj);
  });
};

var signup = function(email, callback) {
  // Email addresses must be lower case
  email = email.toLowerCase();

  var auth = new models.Auth();
  auth.email = email;
  auth.password = createPassword(email);

  // Also create the relevant user object
  var user = new models.User();
  user.avatar = gravatar.getAvatarUrl(email);
  // In order to give the new Auth object a reference to this
  // user, it needs to have an id.  However, since it hasn't
  // been saved yet it doesn't have one -- as such, we manually
  // bootstrap the fieldset and create an id.
  user.bootstrap().genId(function() {
    auth.creator = user._id;

    // Set the initial name based on the email address
    user.name = email.match(/[^\w-_]/);
    if (user.name) {
      user.name = email.substr(0, user.name.index)
    } else {
      user.name = email;
    }

    // Save the records, and return success when it's done.
    db.apply(auth, user, function() {

      // Collect all messages and convos that were created using
      // this new user's email address.  We need to associate them
      // with the new user object, and disassociate them from the
      // email.
      db.query(models.Convo, {email: email}, function(err, convos) {

        // If there was an error, just bail
        if (err) return;

        // Update each convo
        for (var i=0; i<convos.length; i++) {
          delete convos[i].lastEmail;
          delete convos[i].email;
          convos[i].creator = auth.creator;
        }

        // Save 'em
        db.apply.apply(this, convos);
      });
      db.query(models.Message, {email: email}, function(err, messages) {

        // If there was an error, just bail
        if (err) return;

        // Update each message
        for (var i=0; i<messages.length; i++) {
          delete messages[i].email;
          messages[i].creator = auth.creator;
        }

        // Save 'em
        db.apply.apply(this, messages);
      });

      // Since those updates fail silently, we can return success
      // early.
      callback(auth, user);
    });
  });
};

var auth = function(client, data, callback, errback, force) {

  //
  // This code here is per-client auth rate limiting.  We begin
  // stalling responses to messages if the client tries to auth
  // too many times.
  //
  // We also do per-email auth rate limiting.  We begin stalling
  // responses to auth messages for a particular email if clients
  // try to auth against it too many times.
  //
  // The algorithm is simple: every time a client tries to auth,
  // we increase the time they wait on the next auth call by 0.5s.
  // We also remove 0.5s from that delay every 10s.  We do the same
  // thing on an email level as well.
  //
  // The maximum rate of auth attempts an attacker could reach is a
  // little complicated and involves calculus.  I'll do this on my own
  // time, but for now this little scheme should provide quite
  // reasonable protection.
  //

  // Initialize client-based delays
  if (client.state.authDelay === undefined) {

    // Set the initial auth delay to 0
    client.state.authDelay = 0;

    // Every 10s, lower the auth delay
    client.state.authDelayInterval = setInterval(function() {

      // Lower by 0.5s
      client.state.authDelay -= 500;

      // Avoid going into the negatives
      if (client.state.authDelay < 0)
        client.state.authDelay = 0;

    }, 10 * 1000); //10s

    // When the client DC's clear the interval
    client.on('disconnect', function() {
      clearInterval(client.state.authDelayInterval);
    });
  }

  // Initialize email-based delays
  if (emailDelays[data.email] === undefined) {

    // Set the initial auth delay to 0
    emailDelays[data.email] = 0;

    // Every 10s, lower the auth delay
    emailDelayIntervals[data.email] = setInterval(function() {

      // Lower by 0.5s
      emailDelays[data.email] -= 500;

      // If the delay is back to 0, remove this interval and delete
      // the delay so that this initialization logic will be
      // re-enabled on the next login attempt on this email.
      if (emailDelays[data.email] <= 0) {

        // Clear this interval
        clearInterval(emailDelayIntervals[data.email]);

        // Delete the relevant state
        delete emailDelays[data.email];
        delete emailDelayIntervals[data.email];
      }

    }, 10 * 1000); //10s
  }

  // Each time `auth` is called, increase the auth delay for both
  // the client making the call, and the email being auth'd against.
  //
  // Note that we check the `force` argument to prevent these from
  // incremented more that once per call (if we didn't, it would
  // happen twice -- once in the first call, and a second time in the
  // bounced callback).
  if (!force) {
    client.state.authDelay += 500;
    emailDelays[data.email] += 500;

    // Cap per-email delays at 15s to mitigate DoSing.
    if (emailDelays[data.email] > 15 * 1000) //15s
      emailDelays[data.email] = 15 * 1000; //15s
  }

  // If we have to delay for auth, bounce this call.  Note that we use
  // the `force` argument as a way to bypass this check.
  if (!force && (emailDelays[data.email] || client.state.authDelay)) {

    // Use the larger of the two delays
    var delay = Math.max(emailDelays[data.email], client.state.authDelay);

    // Bounce the call
    setTimeout(function() { auth(client, data, callback, errback, true); }, delay);

    // And make this a no-op.
    return;
  }

  //
  // Here follows the actual authentication business logic.
  //

  authUser(data.email, data.password, function(err, bad, auth) {

    // This function sets the auth state for the cilent when called
    var finish = function() {
      // Save the auth for the client
      client.state.auth = auth;

      // Update presence information
      presence.online(client);

      // Remove the auth on dc
      client.on('disconnect', function() {
        // Clear the presence information
        try {
          presence.offline(client);
          delete client.state.auth;
        } catch (err) {
          console.log('Error on client disconnect');
          console.log(err.stack || err);
          console.log('');
        }
      });

      // On pause/resume, update presence
      client.on('pause', function() {
        presence.away(client);
      });
      client.on('resume', function() {
        presence.online(client);
      });

      // Notify success!
      callback({
        password: auth.password,
        userid: auth.creator
      });
    };

    // Bail entirely if something went wrong
    if (err) return errback(err);

    // Handle incorrect password
    if (bad) return callback(false);

    // If the user object doesn't exist, create it
    if (!auth)
      signup(data.email, function(newAuth, user) {
        auth = newAuth;
        return finish();
      });
    // Otherwise, just wrap up.
    else
      return finish();
  });
};

var passwd = function(client, data, callback, errback) {

  // Make sure the client is already authenticated
  if (!client.state.auth) return callback(false);

  // DRY
  var auth = client.state.auth;

  // Make sure the passwords match
  if (auth.password != hashPassword(data.old, auth.email)) return callback(false);

  // Hash the new password
  var password = hashPassword(data.password, auth.email);

  // Save it
  auth.password = password;
  db.apply(auth);

  // Return the hashed form to the user
  callback(password);
};

var newpw = function(client, data, callback, errback) {
  db.queryOne(models.Auth, {email: data.email.toLowerCase()}, function(err, obj) {

    // Return error on failure
    if (err) return errback('Database error');

    // If the auth object doesn't exist, return true immmediately
    if (!obj) return callback(true);

    // Set the new password and save the result.  Note that
    // the createPassword() function will automatically send an email.
    obj.password = createPassword(data.email, true);
    db.apply(obj, function() {
      return callback(true);
    });
  })
};

// Handlers
exports.auth = auth;
exports.passwd = passwd;
exports.newpw = newpw;

// Misc
exports.authUser = authUser;
exports.signup = signup;
