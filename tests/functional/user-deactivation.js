'use strict'

const test      = require('tape')

const {
  data,
  connectUser,
  connectAdmin,
  createTest  } = require('../_test-utils')

const WAIT      = 2

const T1 = `USER – deactivate & can't connect anymore`
test( T1, createTest( false, async (t, nm) => {

  const t1 = await nm
    .use( connectAdmin() )
    .wait( WAIT )
    .goto(`http://localhost:8000/users/${ data.ACTIVE_USER_ID }`)
    .wait( WAIT )
    .evaluate( () => {
      const iconEl  = document.querySelector('.mdl-list li:nth-child(5) i')
      const icon    = iconEl ? iconEl.textContent : 'no icon to display on user card'
      return { icon }
    })

  t.equal( t1.icon, 'check', `${T1} – user is active to begin with` )

  const t2 = await nm
    .realClick( `a[href="/users"]` )
    .wait( WAIT )
    .realClick( `a[href^="/users/${ data.ACTIVE_USER_ID }?_method=DELETE"]` )
    .wait( WAIT )
    .realClick( `a.js-dialog-confirm` )
    .wait( WAIT )
    .evaluate( id => {
      const userLinkEl  = document.querySelector(`a[href="/users/${id}`)
      const line        = userLinkEl.parentNode.parentNode
      const status      = line.querySelector(`td:nth-child(5)`).textContent
      return { status }
  }, data.ACTIVE_USER_ID )

  t.equal( t2.status, 'deactivated', `${T1} – user link deactivated in user listing` )

  const t3 = await nm
    .realClick( `a[href="/logout"]` )
    .goto( 'http://localhost:8000' )
    .wait( WAIT )
    .insert( '#email-field', data.ACTIVE_USER_EMAIL )
    .insert( '#password-field', data.ACTIVE_USER_PASS )
    .wait( WAIT )
    .realClick( 'form[action*="/login"] [type=submit]' )
    .wait( 'dl.message.error' )
    // chaining waits seems to make timeout problems…
    // .wait( WAIT )
    .evaluate( () => {
      const errorEl = document.querySelector('.message.error p')
      return { errorMessage: errorEl ? errorEl.textContent : false }
    })

  t.equal(t3.errorMessage, `This account doens't exist or hasn't been activated`, `${T1} – user can't connect anymore`)

}))

const T2 = 'USER – deactivate & reactivate'
test( T2, createTest( false, async (t, nm) => {

  const t1 = await nm
    .use( connectAdmin() )
    .goto(`http://localhost:8000/users/${ data.ACTIVE_USER_ID }` )
    .wait( WAIT )
    .realClick(`a[href^="/users/${ data.ACTIVE_USER_ID }?_method=DELETE"]`)
    .wait( WAIT )
    .realClick( `a.js-dialog-confirm` )
    .wait( WAIT )
    .evaluate( () => {
      const iconEl  = document.querySelector( '.mdl-list li:nth-child(4) i' )
      const icon    = iconEl ? iconEl.textContent : 'no icon to display on user card'
      return { icon }
    })

  t.equal( t1.icon, 'airline_seat_individual_suite', `${T2} – user is unactive to begin with` )

  const t2 = await nm
    .realClick( `a[href^="/users/${ data.ACTIVE_USER_ID }/activate"]` )
    .wait( WAIT )
    .realClick( `a.js-dialog-confirm` )
    .wait( WAIT )
    .evaluate( () => {
      const iconEl = document.querySelector('.mdl-list li:last-child i')
      const icon   = iconEl ? iconEl.textContent : 'no icon to display on user card for .mdl-list li:nth-child(5) i'
      return { icon }
    })

  t.equal( t2.icon, 'report_problem', `${T2} – user link deactivated in user card` )

  const t3 = await nm
    .goto( `http://localhost:8000/groups/${ data.GROUP_ID }` )
    .wait( WAIT )
    .realClick(`a[href="#user-panel"]`)
    .wait( WAIT )
    .evaluate( id => {
      const userLinkEl = document.querySelector(`#user-panel a[href="/users/${id}`)
      if (!userLinkEl) return { status: false }
      const line       = userLinkEl.parentNode.parentNode
      const status     = line.querySelector(`td:nth-child(4)`).textContent
      return { status }
    }, data.ACTIVE_USER_ID )

  t.equal( t3.status, 'to be initialized', `${T2} – user is reseted` )

}))
