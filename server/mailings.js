'use strict'

const _           = require('lodash')
const qs          = require('qs')
const util        = require('util')
const createError = require('http-errors')
const moment      = require('moment')
const { Types }   = require('mongoose')

const config        = require('./config')
const filemanager   = require('./filemanager')
const {
  Templates,
  Mailings,
  Galleries,
  Users,
  addGroupFilter,
  addStrictGroupFilter,
}                         = require('./models')
const cleanTagName        = require('../shared/clean-tag-name')
const { normalizeString } = require('./models/utils')

const translations  = {
  en: JSON.stringify(_.assign(
    {},
    require('../res/lang/mosaico-en.json'),
    require('../res/lang/custom-en')
  )),
  fr: JSON.stringify(_.assign(
    {},
    require('../res/lang/mosaico-fr.json'),
    require('../res/lang/custom-fr')
  )),
}

//////
// HOME LISTING
//////

const perpage = 25

function userList(req, res, next) {
  const { query, user } = req
  const isAdmin         = user.isAdmin
  // admin doesn't have a group
  const _group        = isAdmin ? { $exists: false } : req.user._group

  //----- PAGINATION

  // Pagination could be done better
  // http://stackoverflow.com/questions/5539955/how-to-paginate-with-mongoose-in-node-js/23640287#23640287
  // https://scalegrid.io/blog/fast-paging-with-mongodb/
  const pagination  = {
    page:   query.page ? ~~query.page - 1 : 0,
    limit:  query.limit ? ~~query.limit : perpage,
  }
  pagination.start  = pagination.page * pagination.limit

  //----- SORTING

  const sorting     = {
    sort: query.sort  ? query.sort  : 'updatedAt',
    dir:  query.dir   ? query.dir   : 'desc',
  }
  // beware that sorting on populated keys won't work
  const sort = { [sorting.sort]: sorting.dir === 'desc' ? -1 : 1}

  //----- FILTERING

  // CLEANING QUERY

  // remove empty fields
  let filterQuery = _.pick( query, ['name', '_user', '_template', 'createdAt', 'updatedAt', 'tags'] )
  ;['createdAt', 'updatedAt'].forEach( key => {
    if (!query[key]) return
    filterQuery[ key ]  = _.omitBy( filterQuery[ key ], value => value === '' )
  })
  filterQuery           = _.omitBy( filterQuery, value => {
    const isEmptyString = value === ''
    const isEmptyObject = _.isPlainObject(value) && Object.keys(value) < 1
    return isEmptyString || isEmptyObject
  } )

  const filterKeys    = Object.keys( filterQuery )

  // normalize array
  let arrayKeys = ['_user', '_template', 'tags']
  arrayKeys     = _.intersection( arrayKeys, filterKeys )
  for (let key of arrayKeys) {
    filterQuery[ key ] = _.concat( [], filterQuery[ key ] )
  }

  // CONSTRUCT MONGODB FILTER

  const filter  = { _group }
  // text search can be improved
  // http://stackoverflow.com/questions/23233223/how-can-i-find-all-documents-where-a-field-contains-a-particular-string
  if (filterQuery.name) filter.name = new RegExp(filterQuery.name)
  // SELECT
  for (let keys of arrayKeys ) { filter[keys] = { $in: filterQuery[keys] } }
  // DATES
  // for…of breaks on return, use forEach
  const datesFilterKeys = _.intersection( ['createdAt', 'updatedAt'], filterKeys )
  datesFilterKeys.forEach( key => {
    const rangeKeys = _.intersection( ['$lte', '$gte'], Object.keys( filterQuery[key] ) )
    rangeKeys.forEach( range => {
      // force UTC time for better comparison purpose
      const date = moment(`${filterQuery[key][range]} +0000`, 'YYYY-MM-DD Z')
      if (!date.isValid()) return
      // day begin at 00h00… go to the next ^^
      if (range === '$lte') date.add(1, 'days')
      filter[key]         = filter[key] || {}
      filter[key][range]  = date.toDate()
    })
  })

  //----- CREATE DB QUERIES

  // don't use lean, we need virtuals
  const mailingsPaginate  = Mailings
  .find( filter )
  .sort( sort )
  .skip( pagination.page * pagination.limit )
  .limit( pagination.limit )

  const mailingsTotal = Mailings
  .find( filter )
  .lean()

  // Extract used tags from mailings
  // http://stackoverflow.com/questions/14617379/mongoose-mongodb-count-elements-in-array
  const tagsList = Mailings
  .aggregate( [
    { $match: {
       _group,
      tags:     { $exists: true },
    } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', } },
    { $sort:  { _id: 1 } }
  ])

  // tagsList.then(tags => console.log( tags.map( t => t._id ) ))

  // gather informations for select boxes
  const usersRequest      = isAdmin ? Promise.resolve(false)
  : Users.find( { _group: user._group }, '_id name').lean()

  const templatesRequest  = isAdmin ? Templates.find({}, '_id name').lean()
  : Templates.find( { _group: user._group }, '_id name').lean()


  //----- GATHER ALL INFOS

  Promise
  .all( [
    mailingsPaginate,
    mailingsTotal,
    usersRequest,
    templatesRequest,
    tagsList
  ] )
  .then( ([paginated, filtered, users, templates, tags]) => {

    // PAGINATION STATUS

    const total         = filtered.length
    const isFirst       = pagination.start === 0
    const isLast        = pagination.page >= Math.trunc(total / perpage)
    pagination.total    = total
    pagination.current  = `${pagination.start + 1}-${pagination.start + paginated.length}`
    pagination.prev     = isFirst ? false : pagination.page
    pagination.next     = isLast  ? false : pagination.page + 2

    // SUMMARY STATUS

    // “translate” ids: need users & templates in order to compute
    let idToName = ['_user', '_template']
    idToName     = _.intersection( idToName, filterKeys )
    for (let key of idToName) {
      const dataList = key === '_user' ? users : templates
      filterQuery[ key ] = filterQuery[ key ].map( id => {
        return _.find( dataList, value => `${value._id}` === id ).name
      } )
    }

    // format for view
    const i18nKeys = {
      name:       'filter.summary.contain',
      _user:      'filter.summary.author',
      _template:  'filter.summary.template',
      createdAt:  'filter.summary.createdat',
      updatedAt:  'filter.summary.updatedat',
      tags:       'filter.summary.tags',
    }
    const summary   = []
    _.forIn( filterQuery, (value, key) => {
      let i18nKey = i18nKeys[ key ]
      if ( _.isString(value) ) return summary.push( { message: i18nKey, value} )
      if ( _.isArray(value) ) {
        return summary.push( { message: i18nKey, value: value.join(', ')} )
      }
      // dates…
      summary.push( { message: i18nKey } )
      if (value.$gte) {
        summary.push( {
          message: 'filter.summary.after',
          value:    value.$gte
        } )
      }
      if (value.$gte && value.$lte ) {
        summary.push( {
          message: 'filter.summary.and',
        } )
      }
      if (value.$lte) {
        summary.push( {
          message: 'filter.summary.before',
          value:    value.$lte
        } )
      }
    })

    // FINALLY RENDER \o/
    res.render('mailing-list', {
      data: {
        mailings:  paginated,
        tagsList:  tags.map( t => t._id ),
        pagination,
        filterQuery,
        users,
        templates,
        summary,
      }
    })
  })
  .catch(next)
}

//////
// EDITOR
//////

function show(req, res, next) {
  var data = {
    translations: translations[ res.getLocale() ],
  }
  Mailings
  .findOne( addGroupFilter(req.user, { _id: req.params.mailingId}) )
  .populate( '_template', '_id assets' )
  .then( mailing => {
    if (!mailing) return next( createError(404) )
    res.render('mailing-edit', { data: _.assign( {}, data, mailing.mosaico) })
  })
  .catch(next)
}

//////
// NEW MAILING
//////

function create(req, res, next) {
  const { templateId }  = req.query
  const filter          = addGroupFilter(req.user, { _id: templateId })

  Templates
  .findOne( filter, '_id _group name')
  .lean()
  .then( onTemplate )
  .catch( next )

  function onTemplate( template ) {
    if (!template) return next( createError(404) )
    const initParameters = {
      // Always give a default name: needed for ordering & filtering
      // use res.__ because (not req) it's where i18n is always up to date (index.js#192)
      name:         res.__('home.saved.noname'),
      _template:    template._id,
      templateName: template.name,
    }
    // admin doesn't have valid user id & group
    if (!req.user.isAdmin) {
      initParameters._user  = req.user.id
      initParameters.author = req.user.name
      initParameters._group = req.user._group
    }
    new Mailings( initParameters )
    .save()
    .then( mailing =>  res.redirect(mailing.url.update) )
    .catch( next )
  }
}

//////
// BULK ACTIONS
//////

function getRedirectUrl(req) {
  const query       = qs.stringify( _.omit(req.query, ['_method']) )
  const redirectUrl = query ? `/?${query}` : '/'
  return redirectUrl
}

function updateLabels(req, res, next) {
  const { body }    = req
  let { mailings } = body
  const tagRegex    = /^tag-/
  const redirectUrl = getRedirectUrl(req)
  if (!_.isArray( mailings ) || !mailings.length ) return res.redirect( redirectUrl )

  // Entries will be supported natively without flag in node 7+
  // use lodash for not bumping node version
  // http://node.green/#features
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/entries
  let tags = _.entries( body )
  .filter( element => tagRegex.test( element[0] ) )
  .map( tag => {
    tag[0] = tag[0].replace(tagRegex, '')
    return tag
  } )

  Mailings
  .find( addStrictGroupFilter(req.user, {
    _id: {
      $in: mailings.map(Types.ObjectId),
    },
  }) )
  .then(onMailings)
  .catch(next)

  function onMailings(docs) {
    Promise
    .all( docs.map( updateTags ) )
    .then( onSave )
    .catch( next )
  }

  function updateTags(doc) {
    tags.forEach( tagAction => {
      const [tag, action] = tagAction
      if (action === 'unchange') return
      if (action === 'add')    doc.tags = _.union( doc.tags, [ tag ] )
      if (action === 'remove') doc.tags = _.without( doc.tags, tag )
    })
    doc.tags = doc.tags.sort().map( cleanTagName )
    return doc.save()
  }

  function onSave(docs) {
    res.redirect( redirectUrl )
  }
}

function bulkRemove(req, res, next) {
  const { mailings } = req.body
  if (!_.isArray( mailings ) || !mailings.length ) return res.redirect( redirectUrl )
  const redirectUrl   = getRedirectUrl(req)
  const filter        = addStrictGroupFilter(req.user, {
    _id: {
      $in: mailings.map(Types.ObjectId),
    },
  })
  Mailings
  .find( filter )
  .then( onMailings )
  .catch( next )

  function onMailings(mailings) {
    Promise
    .all( mailings.map( mailing => mailing.remove()) )
    .then( _ => res.redirect(redirectUrl) )
    .catch( next )
  }
}

//////
// OTHERS ACTIONS
//////

function update(req, res, next) {
  if (!req.xhr) return next(createError(501)) // Not Implemented

  Mailings
  .findOne( addGroupFilter(req.user, { _id: req.params.mailingId}) )
  .then( handleMailing )
  .catch( next )

  function handleMailing(mailing) {
    if (!mailing) return next( createError(404) )
    mailing.data = req.body.data || mailing.data
    // use res.__ because (not req) it's where i18n is always up to date (index.js#192)
    mailing.name = normalizeString( req.body.name ) || res.__('home.saved.noname')
    // http://mongoosejs.com/docs/schematypes.html#mixed
    mailing.markModified('data')

    return mailing
    .save()
    .then( mailing => res.json( mailing.mosaico ) )
    .catch(next)
  }
}

function remove(req, res, next) {
  const mailingId  = req.params.mailingId
  Mailings
  .findByIdAndRemove(mailingId)
  .then( c => res.redirect('/') )
  .catch(next)
}


// TODO while duplicating we should copy only the used images by the mailing
function duplicate(req, res, next) {
  const { mailingId }    = req.params

  Promise
  .all([
    Mailings.findOne( addGroupFilter(req.user, { _id: mailingId }) ),
    Galleries.findOne( { mailingOrTemplateId: mailingId } ),
  ])
  // Be sure that all images are duplicated before saving the duplicated mailing
  .then( duplicateImages )
  .then( saveMailing )
  .then( redirectToHome )
  .catch( err => {
    if (err.responseSend) return
    next( err )
  } )

  function duplicateImages( [mailing, gallery] ) {
    if (!mailing) {
      next( createError(404) )
      // Early return out of the promise chain
      return Promise.reject( {responseSend: true} )
    }
    const duplicatedMailing = mailing.duplicate( req.user )
    return Promise.all([
      duplicatedMailing,
      gallery,
      filemanager.copyImages( req.params.mailingId, duplicatedMailing._id ),
    ])
  }

  function saveMailing( [duplicatedMailing, gallery] ) {
    return Promise.all( [duplicatedMailing.save(), gallery ])
  }

  function redirectToHome( [duplicatedMailing, gallery] ) {
    res.redirect('/')
    // if gallery can't be created it's not a problem
    // it will be created when opening the duplicated mailing
    // we only loose hidden images
    if ( gallery ) gallery.duplicate( duplicatedMailing._id ).save()
  }

}

module.exports = {
  userList,
  show,
  update,
  remove,
  updateLabels,
  bulkRemove,
  create,
  duplicate,
}
