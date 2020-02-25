const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  saveFiles,
  log,
  utils
} = require('cozy-konnector-libs')
const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  //debug: true,
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
          'userName': fields.login,
          'password': fields.password
      },
      json: true // Automatically stringifies the body to JSON
  };

  await request(login_options)

  log('info', 'Successfully logged in')
  
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Getting info about the subscribed contracts')
  const contracts = await request(`${baseUrl}/api/adherent/contrats`)
  let today = new Date();
  let extraction_start_date = new Date(new Date().setFullYear(new Date().getFullYear() - 2));
  for (contrat of contracts['contrats']) { 
      var numContrat = parseInt(contrat['numContrat'])
      log('info', `Getting data for contrat ${numContrat}`)

      log('info', 'Parsing list of Documents')
      var documents_options = {
          method: 'GET',
          uri: `${baseUrl}/api/adherent/courriers/list`,
          headers: {
              'Content-Type': 'application/json'
          },
          qs: {
              "startDate": extraction_start_date.toISOString(),
              "endDate": today.toISOString(),
              "numeroContratIndividuel": numContrat,
          },
          json: true // Automatically stringifies the body to JSON
      };
      const documents = await request(documents_options)
      let documents_to_download = Array()
      for (document of documents) {
          var document_options = {
              method: 'GET',
              uri: `${baseUrl}/api/adherent/courriers/document`,
              headers: {
                  'Content-Type': 'application/json'
              },
              qs: {
                  "numeroContratIndividuel": numContrat,
                  "docId": parseInt(document['id']),
                  "code": document['code']
              },
              json: false // Automatically stringifies the body to JSON
          };
          const pdf_info = {
            date: document['dateCreation'],
            fileurl: `${baseUrl}/api/adherent/courriers/document`,
            requestOptions: document_options,
            filename: `${utils.formatDate(document['dateCreation'])}_courrier_${VENDOR}_${document['id']}.pdf`,
            vendor: VENDOR,
            metadata: {
              // It can be interesting to add the date of import. This is not mandatory but may be
              // useful for debugging or data migration
              importDate: new Date(),
              // Document version, useful for migration after change of document structure
              version: 1
            }
          }
          documents_to_download.push(pdf_info)
      };
      log('info', 'Downloading documents')
      await saveFiles(documents_to_download, fields, {
        fileIdAttributes: ['numContrat', ],
        subPath: `${numContrat}`,
        contentType: 'application/pdf',
        sourceAccount: this.accountId,
        sourceAccountIdentifier: fields.login
      });
      log('info', 'Parsing list of Payments')
      var payments_options = {
          method: 'GET',
          uri: `${baseUrl}/api/adherent/prestations/paiements`,
          headers: {
              'Content-Type': 'application/json'
          },
          qs: {
              "numContrat": numContrat,
              "period": 24,
              "startDate": extraction_start_date.toISOString().slice(0, 10),
              "endDate": today.toISOString().slice(0, 10)
          },
          json: true // Automatically stringifies the body to JSON
      };
      const payments = await request(payments_options)
      let payments_to_link = Array()
      for (paiement of payments['paiements']) {
          log('info', `Extracting paiement info for paiement ${paiement['numeroPaiement']}`)
          var payment_options = {
              method: 'GET',
              uri: `${baseUrl}/api/adherent/prestations/operations-avec-details/${paiement['numeroPaiement']}`,
              headers: {
                  'Content-Type': 'application/json'
              },
              json: true // Automatically stringifies the body to JSON
          };
          const payment_details = await request(payment_options)
          log('debug', payment_details) 
          for (detail_paiement of payment_details) {
              log('info', `Extracting paiement detail for paiement ${paiement['numeroPaiement']}`)
              for (remboursement of detail_paiement['details']) {
                  log('info', `Found a new refund`)
                  const paiement_info = {
                    amount: remboursement['montantRC'],
                    contractId: paiement['numeroPaiement'],
                    currency: "EUR",
                    date: paiement['datePaiement'],
                    groupAmount: detail_paiement['montantRC'],
                    isRefund: true,
                    originalDate: remboursement['dateDebutSoins'],
                    originalAmount: remboursement['depense'],
                    socialSecurityRefund: remboursement['montantRO'],
                    subtype: remboursement['libelleActe'],
                    type: "health_costs",
                    vendor: VENDOR,
                    metadata: {
                      // It can be interesting to add the date of import. This is not mandatory but may be
                      // useful for debugging or data migration
                      importDate: new Date(),
                      // Document version, useful for migration after change of document structure
                      version: 1
                    }
                  }
                  payments_to_link.push(paiement_info)
             };
          };
      };
      log('info', 'Saving Bills')
      await saveBills(payments_to_link, fields, {
        // This is a bank identifier which will be used to link bills to bank operations. These
        // identifiers should be at least a word found in the title of a bank operation related to this
        // bill. It is not case sensitive.
        identifiers: ['VIASANTE'],
        sourceAccount: this.accountId,
        sourceAccountIdentifier: fields.login
      })
  //});
  };
}

function authenticate(login, password) {
  var login_options = {
      method: 'POST',
      uri: `${baseUrl}/api/identity/login`,
      headers: {
          'Content-Type': 'application/json'
      },
      body: {
          'userName': fields.login,
          'password': fields.password
      },
      json: true // Automatically stringifies the body to JSON
  };

  return request(login_options)
}
