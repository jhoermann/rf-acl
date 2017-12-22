/**
 * get session secret from db
 * acl: check if req route is allowed as express middelware
 * decrypt token an put rights object in req
 */


var jwt = require('jsonwebtoken'),
   async = require('async'),
   NodeCache = require('node-cache'),
   myCache = new NodeCache({
      stdTTL: 1000,
      checkperiod: 250
   }),
   os = require('os'),
   config = require('rf-config'),
   log = require('rf-log'),
   db = require('rf-load').require('db').db,
   app = require('rf-load').require('http').app,
   // websocket = require('rf-load').require('websocket').IO,
   API = require('rf-load').require('rf-api').API,


   _ = require('lodash')



// get internal ip addresses for allowing internal requests
var interfaces = os.networkInterfaces()
var internalIpAddresses = []
for (var k in interfaces) {
   for (var k2 in interfaces[k]) {
      var address = interfaces[k][k2]
      internalIpAddresses.push(address.address.replace('::ffff:', ''))
   }
}

module.exports.start = function (options, startNextModule) {
   // get session secret from db
   db.global.settings.findOne({
      name: 'sessionSecret'
   }, function (err, doc) {
      var sessionSecret
      if (err) log.critical(err)
      if (doc && doc.settings && doc.settings.value) {
         sessionSecret = doc.settings.value
      } else {
         // no secret => create one and put it in db (avalibale for other apps)
         log.info("Couldn't load session secret, creating a new one")
         sessionSecret = require('crypto').randomBytes(64).toString('hex')

         db.global.mongooseConnection.collection('settings').insert({
            name: 'sessionSecret',
            settings: {
               value: sessionSecret
            }
         })
      }
      config.sessionSecret = sessionSecret // login function might need it
      startACL(sessionSecret)
   })


   function startACL (sessionSecret) {
      // Add token processing functions for applications not using express
      // Returns a Promise of userInfo
      /**
       * Verify if a given token is correct in the current context
       */
      function verifyToken (token) {
         return new Promise((resolve, reject) => {
            jwt.verify(token, sessionSecret, { ignoreExpiration: false }, (err, decoded) => {
               if (err) {
                  return reject(err)
               } else {
                  return resolve(decoded)
               }
            })
         })
      }
      /**
       * Check if the current token allows the ACL to take place
       * Returns a Promise that:
       *    - resolves with userInfo if permitted
       *    - rejects if not permitted
       *
       */
      function checkACL (token, acl) {
         // TODO proper implementation
         return verifyToken(token).then(userInfo => {
            // TODO actually verify something. Currently this will accept in any case
            // NOTE: any exception will reject
            // if(acl.section == ...) {...} else {throw new Exception("Not authorized");}
            return userInfo
         }).catch(err => {
            // If ACL is empty, this is not considered an error
            if (_.isEmpty(acl)) {
               return {} // No error, return empty user object
            }
            // Else: This is an error, reject the promise
            throw err
         })
      }
      // Register services
      API.Services.registerFunction(verifyToken)
      API.Services.registerFunction(checkACL)

      /*
      websocket.use(function () {

      })
      */

      /*
      // check if route is protected
      app.use(function (req, res, next) {
         // Do not protect internal requests
         var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
         ip = ip.replace('::ffff:', '')

         if (internalIpAddresses.indexOf(ip) < 0) {
            for (var c in config.acl) {
               if (req.url.match(new RegExp(c, 'g'))) {
                  if (config.acl[c] !== false) { // protected
                     // req._session
                     // req._token

                     // TODO
                     // Check for roles for this route
                     // if (decoded.roles.indexOf(config.acl[c]) < 0) {
                     //    return res.status(403).json({
                     //       success: false,
                     //       message: 'Wrong permissions.'
                     //    }, 403);
                     // }

                     // everything good
                     next()
                  } else { // no token => error
                     next()

                     // return res.status(403).json({
                     //    success: false,
                     //    message: 'No token provided.'
                     // }, 403);
                  }
               } else { // unprotected
                  next('route') // Skip token check and go to next route
               }
            }
         } else { // internal
            if (!config.acl) log.warning('No acls found in config! Nothing is protected!')
            next('route') // Skip token check and go to next route
         }
      })
      */

      // process the token
      app.use(function (req, res, next) {
         // check for token
         var token = req.body.token || req.query.token || req.headers['x-access-token']

         if (token) {
            req._token = token
            async.waterfall([
               function (callback) {
                  verifyToken(token).then(decoded => {
                     req._decoded = decoded
                     req._tokenValid = true
                     callback(null)
                  }).catch(err => {
                     log.error(`Bad token: ${err}`)
                     req._decoded = null
                     req._tokenValid = false
                     callback(null)
                  })
               },
               function (callback) {
                  getSession(token, res)
                     .then(function (session) {
                        req._session = session
                        callback(null)
                     })
                     .catch(function (err) {
                        req._session = null
                        callback(err)
                     })
               }
            ], function (err, session) {
               if (err) console.log(err)
               next()
            })
         // no token
         } else {
            next()
         }

         function getSession (token, res) {
            return new Promise((resolve, reject) => {
               async.waterfall([
                  loadFromCache,
                  loadFromDB,
                  saveToCache
               ], function (err, session) {
                  if (err) {
                     reject(err)
                  } else {
                     resolve(session)
                  }
               })

               function loadFromCache (callback) {
                  // session with key "token" in cache?
                  myCache.get(token, callback)
               }

               function loadFromDB (session, callback) {
                  // not in cache => get from db
                  if (!session) {
                     db.user.sessions
                        .findOne({
                           'token': token
                        })
                        .populate({
                           path: 'user',
                           populate: {
                              path: 'account'
                           }
                        })
                        .exec(function (err, session) {
                           if (err || !session) {
                              callback(err || 'No session found!')
                           } else {
                              callback(null, session)
                           }
                        })
                  } else {
                     callback(null, session)
                  }
               }

               function saveToCache (session, callback) {
                  // put in cache but do not wait for it
                  myCache.set(token, session, function () {})
                  callback(null, session)
               }
            })
         }
      })

      // provide the login url (no acl here)
      app.post('/basic-config', function (req, res) {
         var loginUrls = config.global.apps.login.urls
         var basicInfo = {
            app: config.app,
            loginUrl: loginUrls.main + loginUrls.login,
            loginMainUrl: loginUrls.main
         }
         res.status(200).send(basicInfo).end()
      })

      log.success('Session started')
      startNextModule()
   }
}
