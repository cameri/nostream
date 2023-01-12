import fs from 'fs'
import yaml from 'js-yaml'

import { extname, join } from 'path'
import { mergeDeepRight } from 'ramda'

import { createLogger } from '../factories/logger-factory'
import { ISettings } from '../@types/settings'

const debug = createLogger('settings')

const FileType = {
  yaml: 'yaml',
  json: 'json',
}

export class SettingsStatic {
  static _settings: ISettings

  public static getSettingsFileBasePath(): string {
    return process.env.NOSTR_CONFIG_DIR ?? join(process.cwd(), '.nostr')
  }

  public static getDefaultSettingsFilePath(): string {
    return `${join(process.cwd(), 'resources')}/default-settings.yaml`
  }

  public static loadAndParseYamlFile(path: string): ISettings {
    const defaultSettingsFileContent = fs.readFileSync(path, { encoding: 'utf-8' })
    const defaults = yaml.load(defaultSettingsFileContent) as ISettings
    return defaults
  }

  public static loadAndParseJsonFile(path: string) {
    return JSON.parse(
      fs.readFileSync(
        path,
        { encoding: 'utf-8' }
      )
    )
  }

  public static settingsFileType(path) {
    const files: string[] = fs.readdirSync(path)
    const filteredFiles = files ? files.filter(fn => fn.startsWith('settings')) : []
    if (filteredFiles.length) {
      const extension = extname(filteredFiles.pop())
      return FileType[extension]
    } else {
      return null
    }
  }


  public static loadSettings(path: string, fileType) {
    debug('loading settings from %s', path)

    switch (fileType) {
      case FileType.json: {
        debug('settings.json is deprecated, please use a yaml file based on resources/default-settings.yaml')
        return this.loadAndParseJsonFile(path)
      }
      case FileType.yaml: {
        return this.loadAndParseYamlFile(path)
      }
      default: {
        throw new Error('settings file was missing or did not contain .yaml or .json extensions.')
      }
    }
  }

  public static createSettings(): ISettings {
    if (SettingsStatic._settings) {
      return SettingsStatic._settings
    }
    debug('creating settings')

    const basePath = SettingsStatic.getSettingsFileBasePath()
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath)
    }
    const defaultsFilePath = SettingsStatic.getDefaultSettingsFilePath()
    const fileType = SettingsStatic.settingsFileType(basePath)
    const settingsFilePath = `${basePath}/settings.${fileType}`

    const defaults = SettingsStatic.loadSettings(defaultsFilePath, FileType.yaml)

    try {

      if (fileType) {
        SettingsStatic._settings = mergeDeepRight(
          defaults,
          SettingsStatic.loadSettings(settingsFilePath, fileType)
        )
      } else {
        SettingsStatic.saveSettings(basePath, defaults)
        SettingsStatic._settings = mergeDeepRight({}, defaults)
      }

      return SettingsStatic._settings
    } catch (error) {
      debug('error reading config file at %s: %o', settingsFilePath, error)

      return defaults
    }
  }

  public static saveSettings(path: string, settings: ISettings) {
    debug('saving settings to %s: %o', path, settings)
    return fs.writeFileSync(
      `join(path, 'settings.yaml'),
      yaml.dump(settings),
      { encoding: 'utf-8' },
    )
  }
}
