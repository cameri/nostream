import chai from 'chai'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { load } from 'js-yaml'
import { join } from 'path'

const { expect } = chai

const templateDir = join(process.cwd(), '.github', 'ISSUE_TEMPLATE')
const read = (file: string): string => readFileSync(join(templateDir, file), 'utf-8')

type FormElement = {
  type?: string
  id?: string
  attributes?: { label?: string; value?: string; options?: unknown[]; render?: string }
  validations?: { required?: boolean }
}

type Form = {
  name?: string
  description?: string
  labels?: string[]
  assignees?: string[]
  title?: string
  body?: FormElement[]
}

const formFiles = readdirSync(templateDir).filter((file) => file.endsWith('.yml') && file !== 'config.yml')

// The labels the repository has, which GitHub silently drops from a form when they do not exist.
const REPOSITORY_LABELS = ['bug', 'enhancement', 'documentation', 'security']
const ELEMENT_TYPES = ['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']

describe('issue templates', () => {
  describe('config.yml', () => {
    const config = load(read('config.yml')) as {
      blank_issues_enabled?: boolean
      contact_links?: Array<{ name?: string; url?: string; about?: string }>
    }

    it('turns off blank issues, so every issue starts from a template', () => {
      expect(config.blank_issues_enabled).to.equal(false)
    })

    it('sends security reports to private vulnerability reporting', () => {
      const link = config.contact_links?.find((entry) => entry.url?.includes('/security/advisories/new'))

      expect(link?.url).to.equal('https://github.com/cameri/nostream/security/advisories/new')
    })

    it('links the contributing guide, the development chat, the protocol repository and the website', () => {
      const urls = config.contact_links?.map((entry) => entry.url)

      expect(urls).to.include('https://github.com/cameri/nostream/blob/main/CONTRIBUTING.md')
      expect(urls).to.include('https://t.me/nostream_dev')
      expect(urls).to.include('https://github.com/nostr-protocol/nostr')
      expect(urls).to.include('https://nostream.dev')
    })

    it('does not send protocol questions to a Telegram group, because none is official', () => {
      const telegramUrls = (config.contact_links ?? [])
        .map((entry) => entry.url ?? '')
        .filter((url) => url.startsWith('https://t.me/'))

      expect(telegramUrls).to.deep.equal(['https://t.me/nostream_dev'])
    })

    it('gives every contact link a name, a https url and a description', () => {
      expect(config.contact_links).to.have.length.greaterThan(0)
      for (const link of config.contact_links ?? []) {
        expect(link.name, 'name').to.be.a('string').that.is.not.empty
        expect(link.about, 'about').to.be.a('string').that.is.not.empty
        expect(link.url, 'url').to.match(/^https:\/\//)
      }
    })
  })

  describe('forms', () => {
    it('has the bug report, feature request and documentation forms', () => {
      expect(formFiles.sort()).to.deep.equal(['bug_report.yml', 'documentation.yml', 'feature_request.yml'])
    })

    for (const file of formFiles) {
      describe(file, () => {
        const form = load(read(file)) as Form
        const fields = (form.body ?? []).filter((element) => element.type !== 'markdown')

        it('has a name and a description', () => {
          expect(form.name, 'name').to.be.a('string').that.is.not.empty
          expect(form.description, 'description').to.be.a('string').that.is.not.empty
        })

        it('is labelled with labels the repository has, and assigns nobody', () => {
          expect(form.labels).to.be.an('array').that.is.not.empty
          for (const label of form.labels ?? []) {
            expect(REPOSITORY_LABELS).to.include(label)
          }
          expect(form.assignees).to.equal(undefined)
        })

        it('has no title prefix to delete before writing a title', () => {
          expect(form.title).to.equal(undefined)
        })

        it('only uses element types GitHub knows', () => {
          expect(form.body).to.be.an('array').that.is.not.empty
          for (const element of form.body ?? []) {
            expect(ELEMENT_TYPES).to.include(element.type)
          }
        })

        it('gives every field a label and a unique id', () => {
          const ids = fields.map((field) => field.id)

          for (const field of fields) {
            expect(field.id, 'id').to.be.a('string').that.is.not.empty
            expect(field.attributes?.label, `label of ${field.id}`).to.be.a('string').that.is.not.empty
          }
          expect(new Set(ids).size).to.equal(ids.length)
        })

        it('gives every dropdown at least one option', () => {
          for (const dropdown of fields.filter((field) => field.type === 'dropdown')) {
            expect(dropdown.attributes?.options, `options of ${dropdown.id}`).to.be.an('array').that.is.not.empty
          }
        })

        it('requires at least one field, so an empty issue cannot be filed', () => {
          expect(fields.some((field) => field.validations?.required === true)).to.equal(true)
        })
      })
    }

    describe('bug_report.yml', () => {
      const form = load(read('bug_report.yml')) as Form
      const byId = (id: string) => form.body?.find((element) => element.id === id)

      it('asks for what the maintainers need to reproduce a bug', () => {
        for (const id of ['what-happened', 'version', 'deployment', 'os', 'logs', 'reproduction']) {
          expect(byId(id)?.validations?.required, `${id} is required`).to.equal(true)
        }
      })

      it('leaves the NIPs and the extra context optional', () => {
        expect(byId('nips')?.validations?.required).to.not.equal(true)
        expect(byId('context')?.validations?.required).to.not.equal(true)
      })

      it('shows the logs as code', () => {
        expect(byId('logs')?.attributes?.render).to.be.a('string').that.is.not.empty
      })
    })

    describe('feature_request.yml', () => {
      const form = load(read('feature_request.yml')) as Form

      it('keeps the pledge paragraph of the old template word for word', () => {
        const pledge = form.body?.find((element) => element.type === 'markdown')?.attributes?.value

        expect(pledge).to.contain(
          'If the feature or idea is implemented or resolved to your satisfaction, please consider making a small monetary donation to support the continued development and independence of this project. To help the maintainers gauge on where to focus their effort, please include the amount of your pledge. A wallet address or Lightning invoice will be provided once the feature is complete.',
        )
      })

      it('asks for the pledge amount, and does not insist on it', () => {
        const pledge = form.body?.find((element) => element.id === 'pledge')

        expect(pledge?.type).to.equal('input')
        expect(pledge?.validations?.required).to.not.equal(true)
      })

      it('requires the problem and the proposed solution', () => {
        for (const id of ['problem', 'solution']) {
          expect(form.body?.find((element) => element.id === id)?.validations?.required).to.equal(true)
        }
      })
    })
  })

  describe('security_report.md', () => {
    const template = read('security_report.md')
    const frontMatter = load(template.split('---')[1]) as { name?: string; labels?: string; assignees?: string }

    it('is a markdown template labelled security, with nobody assigned', () => {
      expect(frontMatter.name).to.be.a('string').that.is.not.empty
      expect(frontMatter.labels).to.equal('security')
      expect(frontMatter.assignees).to.equal(undefined)
    })

    it('tells the reporter to use private vulnerability reporting, not this public issue', () => {
      expect(template).to.contain('https://github.com/cameri/nostream/security/advisories/new')
      expect(template).to.contain('Do not describe a vulnerability in this issue')
    })
  })

  it('no longer has the legacy markdown templates, which carried Cameri as the default assignee', () => {
    expect(existsSync(join(templateDir, 'bug_report.md'))).to.equal(false)
    expect(existsSync(join(templateDir, 'feature_request.md'))).to.equal(false)
  })

  it('is run by CI when only a template changes, so these tests protect the files they read', () => {
    const workflow = load(readFileSync(join(process.cwd(), '.github', 'workflows', 'checks.yml'), 'utf-8')) as {
      jobs?: { changes?: { steps?: Array<{ id?: string; with?: { filters?: string } }> } }
    }
    const filterStep = workflow.jobs?.changes?.steps?.find((step) => step.id === 'filter')
    const filters = load(filterStep?.with?.filters ?? '') as { src?: string[] }

    expect(filters.src).to.include('.github/ISSUE_TEMPLATE/**')
  })
})
