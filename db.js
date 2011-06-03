var mongo = require('mongodb'),
    EventEmitter = require('events').EventEmitter;

///////////////////////////////
// Utility
///////////////////////////////

var makeId = function() {
  var out = "";
  for (var i=0; i<8; i++)
    out += (((1+Math.random())*0x10000)|0).toString(16).substring(1);
  return out;
};

var makeNiceId = function(namespace) {
  //todo
};

///////////////////////////////
// DB Stuff
///////////////////////////////

var db;

var init = function(host, port, name, callback) {
  db = new mongo.Db(name, new mongo.Server(host, port, {}));
  db.open(function(err, p_client) {
    if (err) {
      console.log('Unable to open database connection!');
      process.exit();
    } else {
      callback();
    }
  });
};

var apply = function() {
  // Checking for zero arguments here makes things easier down the
  // road.
  if (!arguments.length) return;

  // Shift out the callback if it's there
  var callback;
  if (typeof arguments[arguments.length - 1] == 'function')
    callback = arguments[--arguments.length];

  // Countdown used for determining when to fire the callback
  var opCount = arguments.length;

  //process each fieldset
  for (var i=0; i<arguments.length; i++) {
    var fs = arguments[i];

    //event type
    var eventType = !fs._id ? 'create' : fs.deleted ? 'delete' : 'update';

    //set the updated date
    fs.modified = new Date().getTime() - 1307042003319;

    //perform the upsert
    var upsert = function() {
      // Decrement opcount here -- technically speaking the data
      // hasn't been saved yet, but they have ID's which *should*
      // be all anyone needs... (maybe?)
      if (--opCount == 0 && callback) callback();

      db.collection(fs.getCollection(), function(err, col) {
        //ye olde error dump
        if (err) return console.log(err.stack, '');

        // This is where it gets a little funky.  Upserting with an
        // id doesn't work for update.  So we clone the FS, remove
        // the id, and use it for the query.
        var nfs = fs.clone();
        var nid = fs._id;
        delete nfs._id;

        col.update({_id: nid}, {'$set': nfs}, {upsert: true}, function(err) {
          //ye olde error dump
          if (err) return console.log(err.stack, '');

          //send the event, with the cloned fieldset so event
          //handlers can't clobber the original
          if (!err)
            events.emit(eventType, fs.clone());
        });
      });
    };

    // If there's no ID, it's a new record and we need to set up
    // the default fields and create an id.
    if (!fs._id)
      //generate an id for it
      fs.bootstrap().genId(upsert);
    else
      upsert();
  }
};

var get = function(fs, callback) {
  if (!fs._id) callback(true);
  else db.collection(fs.getCollection(), function(err, col) {
    if (err) callback(true);
    else col.find({_id: fs._id}).limit(1).nextObject(function(err, obj) {
      if (err) callback(true);
      else if (!obj) callback(false, false);
      else fs.merge(obj) && callback(false, true);
    });
  });
};

var queryOne = function(type, q, callback) {
  if (!type.prototype.getCollection) callback(true);
  else db.collection(type.prototype.getCollection(), function(err, col) {
    if (err) callback(true);
    else col.find(q).limit(1).nextObject(function(err, obj) {
      if (err) callback(true);
      else callback(false, obj);
    });
  });
};

var queryRelated = function(type, field, id, callback) {
  var q = {};
  q[field] = id;

  if (!type || !field || !id) callback(true);
  else db.collection(type, function(err, col) {
    if (err) callback(true);
    else col.find(q, {'_id': 1}).toArray(function(err, objs) {
      if (err) callback(true);
      else {
        var ids = [];
        for (var i=0; i<objs.length; i++) ids[i] = objs[i]._id;
        callback(false, ids);
      }
    });
  });
};

///////////////////////////////
// FieldSets
///////////////////////////////

var FieldSet = function(collection) {
  //require collection
  if (!collection)
    throw new Error('Must set collection name when created a fieldset');

  this.getCollection = function() {
    return collection;
  };
};
FieldSet.prototype.genId = function(callback) {
  this._id = makeId();
  if (callback) callback();

  return this;
};
FieldSet.prototype.clone = function() {
  var FS = function() {};
  FS.prototype = new FieldSet(this.getCollection());

  //create the new fieldset
  var fs = new FS();

  //copy the fields over
  for (var i in this) if (this.hasOwnProperty(i))
    fs[i] = this[i];

  //and return it
  return fs;
};
FieldSet.prototype.merge = function(from) {
  for (var i in from) if (from.hasOwnProperty(i))
    this[i] = from[i];

  return this;
};
FieldSet.prototype.bootstrap = function(id) {
  this._id = id;
  this.created = this.modified || (new Date().getTime() - 1307042003319);
  this.deleted = false;

  return this;
};

///////////////////////////////
// Exports
///////////////////////////////

exports.init = init;
exports.apply = apply;
exports.get = get;
exports.queryOne = queryOne;
exports.queryRelated = queryRelated;
exports.makeNiceId = makeNiceId;

exports.FieldSet = FieldSet;

///////////////////////////////
// Events Hack
///////////////////////////////
var events = new EventEmitter();
events.setMaxListeners(0); // TO THE MOOOOOON
exports.events = events;
