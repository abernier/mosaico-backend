const test      = require('tape')
const {
  connectUser,
  connectAdmin,
  createTest, } = require('../_utils')

test('connection success', createTest( 1, false, async (t, nm, close) => {
  const t1 = await nm.use( connectUser() )
  await close()
  t.pass('user is connected')
}))

test('connection fail', createTest( 1, false, async (t, nm, close) => {
  const t1 = await nm
    .goto( 'http://localhost:8000?lang=en' )
    .insert( '#email-field', 'p@p.com' )
    .insert( '#password-field', 'pp' )
    .click( 'form[action*="/login"] [type=submit]' )
    .wait( 'dl.message.error' )
    .evaluate( () => {
      const errorEl = document.querySelector('.message.error p')
      return { errorMessage: errorEl ? errorEl.textContent : false }
    })
  await close()
  t.equal( t1.errorMessage, 'This password is incorrect', 'user has an auth error' )
}))

test('admin connection – success', createTest( 1, false, async (t, nm, close) => {
  const t1 = await nm
    .use( connectAdmin() )
    .url()
  await close()
  t.equal('http://localhost:8000/admin', t1, 'admin is connected')
}))
