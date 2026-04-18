import chai from 'chai'

const { expect } = chai

import { escapeHtml, safeJsonForScript } from '../../../src/utils/html'

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).to.equal('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeHtml('<div>')).to.equal('&lt;div&gt;')
  })

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).to.equal('a &gt; b')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).to.equal('&quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).to.equal('it&#39;s')
  })

  it('escapes all special characters together', () => {
    expect(escapeHtml('<script>alert("it\'s a & test")</script>')).to.equal(
      '&lt;script&gt;alert(&quot;it&#39;s a &amp; test&quot;)&lt;/script&gt;',
    )
  })

  it('returns plain strings unchanged', () => {
    expect(escapeHtml('hello world')).to.equal('hello world')
  })

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).to.equal('')
  })
})

describe('safeJsonForScript', () => {
  it('serializes a string as a quoted JSON value', () => {
    expect(safeJsonForScript('lnbits')).to.equal('"lnbits"')
  })

  it('serializes a number', () => {
    expect(safeJsonForScript(42)).to.equal('42')
  })

  it('serializes null', () => {
    expect(safeJsonForScript(null)).to.equal('null')
  })

  it('serializes an object', () => {
    expect(JSON.parse(safeJsonForScript({ a: 1 }))).to.deep.equal({ a: 1 })
  })

  it('replaces < with \\u003C to prevent </script> injection', () => {
    const result = safeJsonForScript('</script><script>alert(1)')
    expect(result).to.not.include('<')
    expect(result).to.include('\\u003C')
  })

  it('produces valid JSON after escaping <', () => {
    const dangerous = '</script>'
    const result = safeJsonForScript(dangerous)
    expect(JSON.parse(result)).to.equal(dangerous)
  })
})
