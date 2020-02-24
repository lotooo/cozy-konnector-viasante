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
  //await authenticate(fields.login, fields.password)
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
  contracts['contrats'].forEach(async function(contrat){
      var numContrat = parseInt(contrat['numContrat'])

      log('info', 'Parsing list of Documents')
      var documents_options = {
          method: 'GET',
          uri: `${baseUrl}/api/adherent/courriers/list`,
          headers: {
              'Content-Type': 'application/json'
          },
          qs: {
              "startDate": "2018-01-31T23:00:00Z",
              "endDate": "2020-01-31T23:00:00Z",
              "numeroContratIndividuel": numContrat,
          },
          json: true // Automatically stringifies the body to JSON
      };
      const documents = await request(documents_options)
      let documents_to_download = Array()
      documents.forEach(async function(document){
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
          await saveFiles([pdf_info], fields, {
            fileIdAttributes: ['numContrat', ],
            subPath: `${numContrat}`,
            contentType: 'application/pdf',
            sourceAccount: this.accountId,
            sourceAccountIdentifier: fields.login
          })
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
              "startDate": "2018-01-31",
              "endDate": "2020-01-31",
          },
          json: true // Automatically stringifies the body to JSON
      };
      const payments = await request(payments_options)
      payments['paiements'].forEach(async function(paiement){
          var payment_options = {
              method: 'GET',
              uri: `${baseUrl}/api/adherent/prestations/operations-avec-details/${paiement['numeroPaiement']}`,
              headers: {
                  'Content-Type': 'application/json'
              },
              json: true // Automatically stringifies the body to JSON
          };
          const payment_details = await request(payment_options)
          payment_details.forEach(async function(detail_paiement){
              detail_paiement['details'].forEach(async function(remboursement){
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
                  await saveBills([paiement], fields, {
                    // This is a bank identifier which will be used to link bills to bank operations. These
                    // identifiers should be at least a word found in the title of a bank operation related to this
                    // bill. It is not case sensitive.
                    identifiers: ['VIASANTE'],
                    sourceAccount: this.accountId,
                    sourceAccountIdentifier: fields.login
                  })
             });
          });
      });
  });
}

