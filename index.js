'use strict'
const LruStore = require('./lruStore')
const debug = require('debug')('route-cache')
const queues = Object.create(null)

const defaults = {
  keyPrefix: '',
  max: 64 * 1000000, // ~64mb
  cacheRedirects: true,
  length: function (n, key) {
    if (n.body && typeof n.body === 'string') {
      return n.body.length
    }
    return 1
  },
  metrics: {
    requestCounter: undefined,
    hitCounter: undefined,
    normalizePath: undefined
  },
  maxAge: 200 // deletes stale cache older than 200ms
}
let cacheStore = new LruStore(defaults)

module.exports.config = function (opts) {
  if (opts) {
    Object.assign(defaults, opts)
    if (opts.cacheStore) {
      cacheStore = opts.cacheStore
    } else {
      cacheStore = new LruStore(defaults)
    }
    module.exports.cacheStore = cacheStore
  }
  return this
}

function drainQueue (key) {
  debug('drainQueue:', key)
  let subscriber = null
  while (queues[key] && queues[key].length > 0) {
    subscriber = queues[key].shift()
    process.nextTick(subscriber)
  }
  delete queues[key]
}

function maybeAddPrefix (key) {
  if (!defaults.keyPrefix) { return key }
  return defaults.keyPrefix + key
}

function getNormalizedPath (path) {
  if (defaults.metrics.normalizePath) {
    return defaults.metrics.normalizePath(path)
  }
  // If no normalize function is provided use an empty path. Otherwise this
  // will blow up the number of time series.
  return ''
}

function countRequest (path) {
  if (defaults.metrics.requestCounter) {
    defaults.metrics.requestCounter.inc({ path: getNormalizedPath(path) })
  }
}

function countHit (path) {
  if (defaults.metrics.hitCounter) {
    defaults.metrics.hitCounter.inc({ path: getNormalizedPath(path) })
  }
}

module.exports.cacheSeconds = function (secondsTTL, cacheKey) {
  const ttl = secondsTTL * 1000
  return function (req, res, next) {
    let key = req.originalUrl // default cache key
    if (typeof cacheKey === 'function') {
      key = cacheKey(req, res) // dynamic key
      // Allow skipping the cache
      if (!key) { return next() }
    } else if (typeof cacheKey === 'string') {
      key = cacheKey // custom key
    }

    key = maybeAddPrefix(key)

    countRequest(req.path)
    cacheStore.get(key + ':redirect').then((redirectKey) => {
      if (redirectKey) {
        res.redirect(redirectKey.status, redirectKey.url)
        countHit(req.path)
        return true
      }
      return false
    }).then((handledByRedirect) => {
      if (handledByRedirect) return true
      return cacheStore.get(key).then((value) => {
        if (value) {
          // returns the value immediately
          debug('hit!!', key)
          if (value.isJson) {
            res.json(value.body)
          } else {
            res.send(value.body)
          }
          countHit(req.path)
          return true
        }
        return false
      })
    }).then((handledByCache) => {
      if (handledByCache) return true

      res.original_send = res.send
      res.original_end = res.end
      res.original_json = res.json
      res.original_redirect = res.redirect

      if (!queues[key]) {
        queues[key] = []
      }

      let didHandle = false

      function rawSend (data, isJson) {
        debug('rawSend', typeof data, data ? data.length : 0)
        // pass-through for Buffer - not supported
        if (typeof data === 'object') {
          if (Buffer.isBuffer(data)) {
            queues[key] = [] // clear queue
            res.set('Content-Length', data.length)
            res.original_send(data)
            return
          }
        }

        didHandle = true
        const body = data instanceof Buffer ? data.toString() : data
        if (res.statusCode < 400) cacheStore.set(key, { body: body, isJson: isJson }, ttl)

        // send this response to everyone in the queue
        drainQueue(key)

        if (isJson) {
          debug('res.original_json')
          res.original_json(body)
        } else {
          debug('res.original_send')
          res.original_send(body)
        }
      }

      // first request will get rendered output
      if (queues[key].length === 0) {
        debug('miss:', key)
        queues[key].push(function noop () {})

        didHandle = false

        res.send = function (data) {
          // debug('res.send() >>', data.length)
          if (didHandle) {
            res.original_send(data)
          } else {
            rawSend(data, false)
          }
        }

        res.end = (data) => {
          res.original_end(data)
          drainQueue(key)
        }

        res.json = function (data) {
          rawSend(data, true)
        }

        // If response happens to be a redirect -- store it to redirect all subsequent requests.
        res.redirect = function (url) {
          let address = url
          let status = 302

          // allow statusCode for 301 redirect. See: https://github.com/expressjs/express/blob/master/lib/response.js#L857
          if (arguments.length === 2) {
            if (typeof arguments[0] === 'number') {
              status = arguments[0]
              address = arguments[1]
            } else {
              console.log('res.redirect(url, status): Use res.redirect(status, url) instead')
              status = arguments[1]
            }
          }

          if (defaults.cacheRedirects) {
            cacheStore.set(key + ':redirect', { url: address, status: status }, ttl)
          }
          res.original_redirect(status, address)
          return drainQueue(key)
        }

        next()
      // subsequent requests will batch while the first computes
      } else {
        debug(key, '>> has queue.length:', queues[key].length)
        queues[key].push(function () {
          cacheStore.get(key + ':redirect')
            .then((redirectKey) => {
              if (redirectKey) {
                res.redirect(redirectKey.status, redirectKey.url)
                return true
              }
              return false
            })
            .then((handledByRedirect) => {
              if (handledByRedirect) return
              return cacheStore.get(key).then((cachedValue) => {
                const value = cachedValue || {}
                debug('>> queued hit:', key, value.length)
                if (value.isJson) {
                  countHit(req.path)
                  res.json(value.body)
                } else {
                  res.send(value.body)
                }
              })
            })
        })
      }
    })
  }
}

module.exports.removeCache = function (url) {
  const key = maybeAddPrefix(url)
  cacheStore.del(key + ':redirect')
  cacheStore.del(key)
}

module.exports.cacheStore = cacheStore
