import * as vscode from 'vscode';
import * as path from 'path';

import * as yaml from 'js-yaml';
import * as ajv from 'ajv';

import {StateManager} from './state';
import * as logging from './logging';
import rollbar from './rollbar';
import {fs} from "./pr";
import * as util from './util';

const log = logging.createLogger('variant');


export type ConfigureArguments = { [key: string]: (string | string[] | number | boolean) };

export interface VariantConfigurationOptions {
  short: string;
  long?: string;
  buildType?: string;
  linkage?: 'static' | 'shared';
  settings?: ConfigureArguments;
  generator?: string;
  toolset?: string;
}

export interface VariantSetting {
  description?: string;
  default_: string;
  choices: Map<string, VariantConfigurationOptions>;
}

export type VariantSet = Map<string, VariantSetting>;

export interface VariantCombination extends vscode.QuickPickItem {
  keywordSettings: Map<string, string>;
}

export interface VariantFileContent {
  [key: string]: {
    default : string; description : string;
    choices : {[name: string] : VariantConfigurationOptions;};
  };
}

export const DEFAULT_VARIANTS: VariantFileContent = {
  buildType : {
    default : 'debug',
    description : 'The build type',
    choices : {
      debug : {
        short : 'Debug',
        long : 'Emit debug information without performing optimizations',
        buildType : 'Debug',
      },
      release : {
        short : 'Release',
        long : 'Enable optimizations, omit debug info',
        buildType : 'Release',
      },
      minsize : {
        short : 'MinSizeRel',
        long : 'Optimize for smallest binary size',
        buildType : 'MinSizeRel',
      },
      reldeb : {
        short : 'RelWithDebInfo',
        long : 'Perform optimizations AND include debugging information',
        buildType : 'RelWithDebInfo',
      }
    }
  }
};

export class VariantManager implements vscode.Disposable {
  /**
   * The variants available for this project
   */
  private _variants: VariantSet = new Map();

  get onActiveVariantChanged() { return this._activeVariantChanged.event; }
  private _activeVariantChanged = new vscode.EventEmitter<void>();

  /**
   * Watches for changes to the variants file on the filesystem
   */
  private _variantFileWatcher = vscode.workspace.createFileSystemWatcher(
      path.join(vscode.workspace.rootPath || '/', 'cmake-variants.*'));

  dispose() {
    this._variantFileWatcher.dispose();
    this._activeVariantChanged.dispose();
  }

  /**
   * Create a new VariantManager
   * @param stateManager The state manager for this instance
   */
  constructor(private readonly _context: vscode.ExtensionContext,
              readonly stateManager: StateManager) {
    log.debug('Constructing VariantManager');
    this._variantFileWatcher.onDidChange(() => {
      rollbar.invokeAsync('Reloading variants file', () => this._reloadVariantsFile());
    });
    this._variantFileWatcher.onDidCreate(() => {
      rollbar.invokeAsync('Reloading variants file', () => this._reloadVariantsFile());
    });
    this._variantFileWatcher.onDidDelete(() => {
      rollbar.invokeAsync('Reloading variants file', () => this._reloadVariantsFile());
    });
    rollbar.invokeAsync('Initial load of variants file', () => this._reloadVariantsFile());
  }

  private async _reloadVariantsFile() {
    const schema_path = this._context.asAbsolutePath('schemas/variants-schema.json');
    const schema = JSON.parse((await fs.readFile(schema_path)).toString());
    const validate = new ajv({allErrors : true, format : 'full'}).compile(schema);

    const workdir = vscode.workspace.rootPath;
    if (!workdir) {
      // Can't read, we don't have a dir open
      return;
    }
    const files = [
      path.join(workdir, 'cmake-variants.json'),
      path.join(workdir, 'cmake-variants.yaml'),
    ];

    let new_variants = DEFAULT_VARIANTS;
    for (const cand of files) {
      if (await fs.exists(cand)) {
        const content = (await fs.readFile(cand)).toString();
        try {
          new_variants = yaml.load(content);
          break;
        } catch (e) {
          log.error(`Error parsing ${cand}: ${e}`);
        }
      }
    }

    const is_valid = validate(new_variants);
    if (!is_valid) {
      const errors = validate.errors as ajv.ErrorObject[];
      log.error('Invalid variants specified:');
      for (const err of errors) {
        log.error(` >> ${err.dataPath}: ${err.message}`);
      }
      new_variants = DEFAULT_VARIANTS;
    } else {
      log.info("Loaded new set of variants");
    }

    const sets = new Map() as VariantSet;
    for (const setting_name in new_variants) {
      const setting = new_variants[setting_name];
      const def = setting.default;
      const desc = setting.description;
      const choices = new Map<string, VariantConfigurationOptions>();
      for (const choice_name in setting.choices) {
        const choice = setting.choices[choice_name];
        choices.set(choice_name, choice);
      }
      sets.set(setting_name, {
        default_ : def,
        description : desc,
        choices : choices,
      });
    }
    this._variants = sets;
  }

  get haveVariant(): boolean {
    return !!this.stateManager.activeVariantSettings;
  }

  get activeVariantOptions(): VariantConfigurationOptions {
    const invalid_variant = {
      short : 'Unknown',
      long : 'Unknwon',
    };
    const kws = this.stateManager.activeVariantSettings;
    if (!kws) {
      return invalid_variant;
    }
    const vars = this._variants;
    if (!vars) {
      return invalid_variant;
    }
    const data = Array.from(kws.entries()).map(([ param, setting ]) => {
      if (!vars.has(param)) {
        debugger;
        throw new Error("Unexpected missing variant setting");
      }
      const choices = vars.get(param) !.choices;
      if (!choices.has(setting)) {
        debugger;
        throw new Error("Unexpected missing variant option");
      }
      return choices.get(setting) !;
    });
    const init: VariantConfigurationOptions = {
      short : '',
      long : '',
      settings: {}
    };
    const result: VariantConfigurationOptions
        = data.reduce((acc, el) => ({
                        buildType : el.buildType || acc.buildType,
                        generator : el.generator || acc.generator,
                        linkage : el.linkage || acc.linkage,
                        toolset : el.toolset || acc.toolset,
                        settings: Object.assign({}, acc.settings, el.settings),
                        short : [acc.short, el.short].join(' ').trim(),
                        long : [acc.long, el.long].join(', '),
                      }),
                      init);
    return result;
  }

  async selectVariant() {
    const variants = Array.from(this._variants.entries())
                         .map(([ key, variant ]) => Array.from(variant.choices.entries())
                                                        .map(([ value_name, value ]) => ({
                                                               settingKey : key,
                                                               settingValue : value_name,
                                                               settings : value
                                                             })));
    const product = util.product(variants);
    const items: VariantCombination[]
        = product.map(optionset => ({
                        label : optionset.map(o => o.settings.short).join(' + '),
                        keywordSettings : new Map<string, string>(optionset.map(
                            param => [param.settingKey, param.settingValue] as[string, string])),
                        description : optionset.map(o => o.settings.long).join(' + '),
                      }));
    const chosen = await vscode.window.showQuickPick(items);
    if (!chosen) {
      return false;
    }
    this.stateManager.activeVariantSettings = chosen.keywordSettings;
    this._activeVariantChanged.fire();
    return true;
  }

  async initialize() { await this._reloadVariantsFile(); }
}
