/* globals decribe */
'use strict'
const assert = require('assert')
const request = require('supertest')
const routeCache = require('../index')
const express = require('express')
const sinon = require('sinon')

let testindex = 0
let testindexRemove = 0

describe('# RouteCache middleware test', function () {
  const app = express()

  before(function () {
    routeCache.config({keyPrefix:'testprefix:'})
  })

  after(function () {
    routeCache.config({})
  })

  app.get('/hello', routeCache.cacheSeconds(1), function (req, res) {
    testindex++
    res.send('Hello ' + testindex)
  })

  app.get('/hello-remove', routeCache.cacheSeconds(3600), function (req, res) {
    testindexRemove++
    res.send('Hello remove ' + testindexRemove)
  })

  const agent = request.agent(app)

  afterEach(function () {
    sinon.restore()
  })

  it('uses prefix in cache key', function (done) {
    const cacheStoreSpy = sinon.spy(routeCache.cacheStore, 'set')
    agent
      .get('/hello')
      .expect(() => {
        assert(cacheStoreSpy.calledOnce);
        assert.equal(cacheStoreSpy.args[0][0], 'testprefix:/hello');
      })
      .expect('Hello 1', done)
  })

  it('removeCache works with prefix', function (done) {
    agent
      .get('/hello-remove')
      .expect('Hello remove 1').end(function (req, res) {
      setTimeout(function () {
        agent
          .get('/hello-remove')
          .expect('Hello remove 1').end(function (req, res) {
          routeCache.removeCache('/hello-remove')

          agent
            .get('/hello-remove')
            .expect('Hello remove 2', done)
        })
      }, 1200)
    })
  })

})
