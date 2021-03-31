// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://b266b0c0678f42d696d1417fac037021@sentry.cozycloud.cc/133'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  saveFiles,
  log,
  utils
} = require('cozy-konnector-libs')
const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: true,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'viasante'
const baseUrl = 'https://adherent.mutuelle-viasante.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  var login_options = {
    method: 'POST',
    uri: `${baseUrl}/api/identity/login`,
    headers: {
      'Content-Type': 'application/json'
    },
    body: {
      userName: fields.login,
      password: fields.password
    },
    json: true // Automatically stringifies the body to JSON
  }

  await request(login_options)

  log('info', 'Successfully logged in')

  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Getting info about the subscribed contracts')
  const contracts = await request(`${baseUrl}/api/adherent/contrats`)
  let today = new Date()
  let extraction_start_date = new Date(
    new Date().setFullYear(new Date().getFullYear() - 2)
  )
  for (let contrat of contracts['contrats']) {
    var numContrat = parseInt(contrat['numContrat'])
    log('debug', `${Object.keys(contrat)}`)
    log('debug', `${Object.keys(contrat['souscripteur']['numPers'])}`)
    var numPers = parseInt(contrat['souscripteur']['numPers'])
    log('info', `Getting data for contrat ${numContrat}`)

    log('info', 'Getting list of available documents')
    var documents_options = {
      method: 'GET',
      uri: `${baseUrl}/api/adherent/courriers/list`,
      headers: {
        'Content-Type': 'application/json',
        'X-NumContrat': numContrat,
        'X-NumPers': numPers
      },
      qs: {
        startDate: extraction_start_date.toISOString(),
        endDate: today.toISOString()
      },
      json: true // Automatically stringifies the body to JSON
    }

    const documents = await request(documents_options)
    log(
      'info',
      `Found ${
        documents.length
      } documents from ${extraction_start_date.toISOString()} to ${today.toISOString()}`
    )
    let documents_to_download = Array()
    let document_per_day = {}
    for (let document of documents) {
      log('debug', `filename: ${document['fileName']}`)
      log('debug', `type: ${document['type']}`)
      let real_document_date = utils.formatDate(document['creationDate'])

      var document_options = {
        method: 'GET',
        uri: `${baseUrl}/api/adherent/courriers/document`,
        headers: {
          'Content-Type': 'application/json'
        },
        qs: {
          fileName: document['fileName'],
          numContrat: numContrat,
          codeCentreGestion: 'VIASANTE',
          docId: parseInt(document['id']),
          type: document['type']
        },
        json: false // Automatically stringifies the body to JSON
      }

      const pdf_info = {
        date: document['creationDate'],
        fileurl: `${baseUrl}/api/adherent/courriers/document`,
        requestOptions: document_options,
        filename: `${utils.formatDate(document['creationDate'])}_${VENDOR}_${
          document['id']
        }.pdf`,
        vendor: VENDOR,
        metadata: {
          // It can be interesting to add the date of import. This is not mandatory but may be
          // useful for debugging or data migration
          importDate: new Date(),
          // Document version, useful for migration after change of document structure
          version: 1
        }
      }
      if (document['type'] == 'PRESTATIONS') {
        // This is a "Relevé de paiement"
        // Let's not use saveFiles on those
        // We'll link them to a bill first
        document_per_day[real_document_date] = pdf_info
      } else {
        documents_to_download.push(pdf_info)
      }
    }
    log('info', 'Downloading documents')
    await saveFiles(documents_to_download, fields, {
      fileIdAttributes: ['numContrat'],
      subPath: `${numContrat}`,
      contentType: 'application/pdf',
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login
    })
    log('info', 'Getting list of received payments')
    var payments_options = {
      method: 'GET',
      uri: `${baseUrl}/api/adherent/prestations/paiements`,
      headers: {
        'Content-Type': 'application/json',
        'X-NumContrat': numContrat,
        'X-NumPers': numPers
      },
      qs: {
        numContrat: numContrat,
        period: 24,
        startDate: extraction_start_date.toISOString().slice(0, 10),
        endDate: today.toISOString().slice(0, 10)
      },
      json: true // Automatically stringifies the body to JSON
    }
    const payments = await request(payments_options)
    log(
      'info',
      `Found ${
        payments['paiements'].length
      } paiements from ${extraction_start_date.toISOString()} to ${today.toISOString()}`
    )
    let payments_to_link = Array()
    let document_to_link = null
    for (let paiement of payments['paiements']) {
      log(
        'info',
        `Extracting payment info for payment ${paiement['numeroPaiement']}`
      )

      /*
          Let's try to find a mail about this payment
          We extract the payment date and check the list of
          received documents (mails) to find the good one
          */

      /* Fist, let's order properly our array */
      const ordered_document_per_day = Object.keys(document_per_day).sort().reduce(
        (obj, key) => {
          obj[key] = document_per_day[key];
          return obj;
        },
        {}
      );
      for (let document_date in ordered_document_per_day) {
        // Parse the string and convert it to a Date object
        let mail_date = new Date(Date.parse(document_date))
        if (new Date(Date.parse(paiement['datePaiement'])) < mail_date) {
          // We are looping the keys in order
          // if our paiement is more recent than our mail,
          // it means we found the good mail
          document_to_link = document_date
          break
        }
        log(
          'debug',
          `Mail was sent on ${document_date} which is before the paiement received on ${
            paiement['datePaiement']
          }`
        )
      }
      if (document_to_link == null) {
        log(
          'info',
          `Payment ${
            paiement['numeroPaiement']
          } has not been notified in a mail yet. Skipping it"`
        )
        continue
      }
      var payment_options = {
        method: 'GET',
        uri: `${baseUrl}/api/adherent/prestations/operations-avec-details/${
          paiement['numeroPaiement']
        }`,
        headers: {
          'Content-Type': 'application/json',
          'X-NumContrat': numContrat,
          'X-NumPers': numPers
        },
        qs: {
          numContrat: numContrat,
          numPaiement: paiement['numeroPaiement'],
          period: 24,
          startDate: extraction_start_date.toISOString().slice(0, 10),
          endDate: today.toISOString().slice(0, 10)
        },
        json: true // Automatically stringifies the body to JSON
      }
      const payment_details = await request(payment_options)
      for (let detail_paiement of payment_details) {
        for (let remboursement of detail_paiement['details']) {
          const paiement_info = {
            amount: remboursement['montantRC'],
            contractId: numContrat,
            currency: 'EUR',
            date: new Date(Date.parse(paiement['datePaiement'])),
            groupAmount: detail_paiement['montantRC'],
            isRefund: true,
            originalDate: new Date(Date.parse(remboursement['dateDebutSoins'])),
            originalAmount: remboursement['depense'],
            socialSecurityRefund: remboursement['montantRO'],
            subtype: remboursement['libelleActe'],
            type: 'health_costs',
            vendor: VENDOR,
            filename: document_per_day[document_to_link]['filename'],
            fileurl: document_per_day[document_to_link]['fileurl'],
            requestOptions:
              document_per_day[document_to_link]['requestOptions'],
            metadata: {
              // It can be interesting to add the date of import. This is not mandatory but may be
              // useful for debugging or data migration
              importDate: new Date(),
              // Document version, useful for migration after change of document structure
              version: 1
            }
          }
          payments_to_link.push(paiement_info)
        }
      }
    }
    log('info', 'Saving Bills')
    await saveBills(payments_to_link, fields, {
      // This is a bank identifier which will be used to link bills to bank operations. These
      // identifiers should be at least a word found in the title of a bank operation related to this
      // bill. It is not case sensitive.
      identifiers: ['VIASANTE'],
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login
    })
    // });
  }
}
