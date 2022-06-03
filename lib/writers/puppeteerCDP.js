const WARCWriterBase = require('./warcWriterBase')
const { CRLF } = require('./warcFields')
const { noGZ, replaceContentLen } = require('./constants')
const { exit } = require('process')
const {contentTypeCheck} = require('../../../filter')

/**
 * @desc WARC Generator for use with puppeteer
 * @see https://github.com/GoogleChrome/puppeteer
 * @extends {WARCWriterBase}
 */
class PuppeteerCDPWARCGenerator extends WARCWriterBase {
  /**
   * @param {PuppeteerCDPRequestCapturer} capturer  - The PuppeteerCDP request capturer that contains requests
   * to be serialized to the WARC
   * @param {CDPSession} client - A CDPSession connected to the target the response bodies will be retrieved from
   * @param {WARCGenOpts} genOpts - Options for generating the WARC and optionally generating
   * WARC info, WARC info + Webrecorder Player bookmark list, metadata records
   * @return {Promise<void>} - A Promise that resolves when WARC generation is complete
   */
  async generateWARC (capturer, client, genOpts) {
    const { winfo, metadata, warcOpts, rejectType } = genOpts
    this.initWARC(warcOpts.warcPath, warcOpts)
    if (winfo != null) {
      await this.writeWarcInfoRecord(winfo)
    }
    if (genOpts.pages) {
      await this.writeWebrecorderBookmarksInfoRecord(genOpts.pages)
    }
    if (metadata != null) {
      await this.writeWarcMetadata(metadata.targetURI, metadata.content)
    }
    for (let request of capturer.iterateRequests()) {
      try {
        await this.generateWarcEntry(request, client, rejectType)
      } catch (error) {
        /* istanbul ignore next */
        console.error(error)
      }
    }
    return new Promise(resolve => {
      this.once('finished', resolve)
      this.end()
    })
  }

  /**
   * @desc Generate a WARC record
   * @param {CDPRequestInfo} nreq - The captured HTTP info
   * @param {CDPSession} client - A CDPSession connected to the target the response bodies will be retrieved from
   * @return {Promise<void>}
   */
  async generateWarcEntry (nreq, client, rejectType) {
    if (nreq.url.indexOf('data:') === 0) return
    let postData
    if (nreq.responseHeaders && nreq.responseHeaders['set-cookie']) {
      nreq.responseHeaders['set-cookie'] = nreq.responseHeaders['set-cookie'].replaceAll('\n', ' ')
    }
    if (nreq.status == 304) nreq.status = 200
    // console.log(nreq.url, nreq.method, nreq.status, nreq.getBody)
    if (nreq.canSerializeResponse()) {
      if (nreq.postData) {
        postData = nreq.postData
      } else if (nreq.hasPostData) {
        try {
          let post = await client.send('Network.getRequestPostData', {
            requestId: nreq.requestId
          })
          postData = Buffer.from(post.postData, 'utf8')
        } catch (e) {}
      }
      let resData
      let responseHeaders = nreq.serializeResponseHeaders()
      if (nreq.getBody) {
        let re = /(.*)\/(.*)/
        let wasError = false
        if (nreq.status == 204 || (nreq.responseHeaders && nreq.responseHeaders['content-type']
        && !contentTypeCheck(re.exec(nreq.responseHeaders['content-type']), rejectType))) {
          wasError = true
        } else {
          try {
            let rbody = await client.send('Network.getResponseBody', {
              requestId: nreq.requestId
            })
            // if (rbody &&  rbody.body && rbody.body.length) {
              if (rbody.base64Encoded) {
                resData = Buffer.from(rbody.body, 'base64')
              } else {
                resData = Buffer.from(rbody.body, 'utf8')
              }
            // } else {
            //   console.log('empty body', nreq.url)
            //   return
            // }
          } catch (err) {
            wasError = true
            // console.error('error response', nreq.url, err)
            // return
          }
        }
        if (!wasError) {
          responseHeaders = responseHeaders.replace(noGZ, '')
          responseHeaders = responseHeaders.replace(
            replaceContentLen,
            `Content-Length: ${Buffer.byteLength(resData, 'utf8')}${CRLF}`
          )
        } else {
          // indicate that this record has 0 content
          responseHeaders = responseHeaders.replace(
            replaceContentLen,
            `Content-Length: 0${CRLF}`
          )
        }
      }
      return this.writeRequestResponseRecords(
        nreq.url,
        {
          headers: nreq.serializeRequestHeaders(),
          data: postData
        },
        {
          headers: responseHeaders,
          data: resData
        }
      )
    } else {
      // console.error('not serialize')
    }
    // return this.writeRequestRecord(
    //   nreq.url,
    //   nreq.serializeRequestHeaders(),
    //   postData
    // )
  }
}

/**
 * @type {PuppeteerCDPWARCGenerator}
 */
module.exports = PuppeteerCDPWARCGenerator
