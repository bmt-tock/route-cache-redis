/* globals decribe */
'use strict'
const assert = require('assert')
const express = require('express')
const request = require('supertest')
const routeCache = require('../index')
const sinon = require("sinon")

let testindex = 0

class FakeCounter {
  constructor() {
    this.reset();
  }

  inc() {
    this.value += 1
  }

  reset() {
    this.value = 0;
  }
}

describe.only('# RouteCache metrics test', function () {
  const app = express()
  const requestCounter = new FakeCounter();
  const hitCounter = new FakeCounter();

  routeCache.config({metrics: {requestCounter, hitCounter}})


  app.get('/hello', routeCache.cacheSeconds(1), function (req, res) {
    testindex++
    res.send('Hello ' + testindex)
  })

  app.get('/hello/1', routeCache.cacheSeconds(1), function (req, res) {
    res.send('Hello/1')
  })

  const agent = request.agent(app)

  before(function () {
    requestCounter.reset()
    hitCounter.reset()
  })

  afterEach(function() {
    sinon.restore()
  })

  after(function () {
    routeCache.config({})
  })

  it('1st Hello misses cache', function (done) {
    agent
      .get('/hello')
      .expect(() => {
        assert.equal(requestCounter.value, 1)
        assert.equal(hitCounter.value, 0)
      })
      .expect('Hello 1', done)
  })

  it('2nd Hello hits cache', function (done) {
    agent
      .get('/hello')
      .expect(() => {
        assert.equal(requestCounter.value, 2)
        assert.equal(hitCounter.value, 1)
      })
      .expect('Hello 1', done)
  })

  it('defaults to empty path', function(done) {
    const requestIncSpy = sinon.spy(requestCounter, 'inc')
    const hitIncSpy = sinon.spy(hitCounter, 'inc')
    agent
      .get('/hello')
      .expect(() => {
        assert(requestIncSpy.calledOnce)
        assert.deepEqual(requestIncSpy.firstCall.args, [{path: ''}])
        assert(hitIncSpy.calledOnce)
        assert.deepEqual(hitIncSpy.firstCall.args, [{path: ''}])
      })
      .expect('Hello 1', done)
  })

  it('uses custom normalize method', function(done) {
    function normalizePath(path) {
      return path.toUpperCase()
    }

    routeCache.config({
      metrics: {
        requestCounter,
        hitCounter,
        normalizePath
      }
    })

    const requestIncSpy = sinon.spy(requestCounter, 'inc')
    const hitIncSpy = sinon.spy(hitCounter, 'inc')
    agent
      .get('/hello')
      .expect(() => {
        assert(requestIncSpy.calledOnce)
        assert.deepEqual(requestIncSpy.firstCall.args, [{path: '/HELLO'}])
      })
      .expect('Hello 2')
      .end(() => {})

    agent
      .get('/hello')
      .expect(() => {
        assert(hitIncSpy.calledOnce)
        assert.deepEqual(hitIncSpy.firstCall.args, [{path: '/HELLO'}])
      })
      .expect('Hello 2')
      .end(done)
  })
})
