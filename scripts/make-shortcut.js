'use strict';

/*
 * Builds the iPhone shortcut that the phone page offers ("Add the shortcut").
 *
 * The shortcut takes the text it is given and posts it to OTP Bridge as
 * {"message": "..."}. When it is added, the Shortcuts app asks for the address
 * once.
 *
 * One automation runs it for every text message, so the shortcut looks at the
 * message first and only passes on those that could hold a code. A text
 * without a digit in it never leaves the phone.
 *
 * iOS only imports shortcut files that Apple has signed, and the signing tool
 * exists only on a Mac. Run `npm run shortcut` on a Mac that is signed in to
 * iCloud after changing anything here; the signed file is kept in the
 * repository so that Windows and Linux users get it too.
 *
 * The signature carries an Apple certificate with an anonymous ID (no name or
 * email) that is valid for about a year. Whether iOS still accepts the file
 * after that date has not been checked, so sign it again before then.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SHORTCUT_NAME = 'OTP Bridge';
const ASSET_NAME = 'otp-bridge.shortcut';
const QUESTION = 'Paste the address shown on the OTP Bridge page.';

const ADDRESS_ACTION = 'B1F0A1C2-6C5E-4E0B-9C59-0A7E5D1C0001';
const SEND_ACTION = 'B1F0A1C2-6C5E-4E0B-9C59-0A7E5D1C0002';
const CHECK_ACTION = 'B1F0A1C2-6C5E-4E0B-9C59-0A7E5D1C0003';
const IF_GROUP = 'B1F0A1C2-6C5E-4E0B-9C59-0A7E5D1C0004';
const END_IF_ACTION = 'B1F0A1C2-6C5E-4E0B-9C59-0A7E5D1C0005';

/**
 * A message is passed on only when this finds something in it. It is written
 * for the Shortcuts app, where \d is a digit in any script. Every message
 * OTP Bridge can find a code in has a digit, or a "#" in front of a code that
 * names its website, so nothing that works without the check is lost by it.
 * test/otp-parser.test.js holds the two to that.
 */
const SEND_IF_PATTERN = '[\\d#]';

/** "has any value", in the Shortcuts app's numbering of If conditions. */
const HAS_ANY_VALUE = 100;

/** Stands in for a variable inside a piece of text. */
const PLACEHOLDER = '\uFFFC';

function tokenText(attachment) {
  return {
    Value: { string: PLACEHOLDER, attachmentsByRange: { '{0, 1}': attachment } },
    WFSerializationType: 'WFTextTokenString',
  };
}

function plainText(string) {
  return { Value: { string }, WFSerializationType: 'WFTextTokenString' };
}

const ACTIONS = [
  {
    WFWorkflowActionIdentifier: 'is.workflow.actions.comment',
    WFWorkflowActionParameters: {
      WFCommentActionText: 'Passes a text message on to OTP Bridge on your computer, if it has a number in it. '
        + 'A Message automation runs this for you. '
        + 'If the computer gets a new address, replace the one in the Text box below.',
    },
  },
  {
    // The address. Filled in by the question asked when the shortcut is added.
    WFWorkflowActionIdentifier: 'is.workflow.actions.gettext',
    WFWorkflowActionParameters: { UUID: ADDRESS_ACTION, WFTextActionText: '' },
  },
  {
    // Could this message hold a code?
    WFWorkflowActionIdentifier: 'is.workflow.actions.text.match',
    WFWorkflowActionParameters: {
      UUID: CHECK_ACTION,
      WFMatchTextPattern: SEND_IF_PATTERN,
      WFMatchTextCaseSensitive: false,
      text: tokenText({ Type: 'ExtensionInput' }),
    },
  },
  {
    // If it could ...
    WFWorkflowActionIdentifier: 'is.workflow.actions.conditional',
    WFWorkflowActionParameters: {
      GroupingIdentifier: IF_GROUP,
      WFControlFlowMode: 0,
      WFCondition: HAS_ANY_VALUE,
      WFInput: {
        Type: 'Variable',
        Variable: {
          Value: { Type: 'ActionOutput', OutputName: 'Matches', OutputUUID: CHECK_ACTION },
          WFSerializationType: 'WFTextTokenAttachment',
        },
      },
    },
  },
  {
    // ... send it to the computer.
    WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
    WFWorkflowActionParameters: {
      UUID: SEND_ACTION,
      WFURL: tokenText({ Type: 'ActionOutput', OutputName: 'Text', OutputUUID: ADDRESS_ACTION }),
      WFHTTPMethod: 'POST',
      WFHTTPBodyType: 'JSON',
      WFJSONValues: {
        Value: {
          WFDictionaryFieldValueItems: [
            { WFItemType: 0, WFKey: plainText('message'), WFValue: tokenText({ Type: 'ExtensionInput' }) },
          ],
        },
        WFSerializationType: 'WFDictionaryFieldValue',
      },
      ShowHeaders: false,
    },
  },
  {
    // End If.
    WFWorkflowActionIdentifier: 'is.workflow.actions.conditional',
    WFWorkflowActionParameters: { GroupingIdentifier: IF_GROUP, WFControlFlowMode: 2, UUID: END_IF_ACTION },
  },
];

const ADDRESS_ACTION_INDEX = ACTIONS.findIndex((a) => a.WFWorkflowActionParameters.UUID === ADDRESS_ACTION);

function shortcutDefinition() {
  return {
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowTypes: [],
    WFWorkflowHasShortcutInputVariables: true,
    // Everything, as a new shortcut has: the automation hands over a message, not plain text.
    WFWorkflowInputContentItemClasses: [
      'WFAppContentItem', 'WFAppStoreAppContentItem', 'WFArticleContentItem', 'WFContactContentItem',
      'WFDateContentItem', 'WFEmailAddressContentItem', 'WFFolderContentItem', 'WFGenericFileContentItem',
      'WFImageContentItem', 'WFiTunesProductContentItem', 'WFLocationContentItem', 'WFDCMapsLinkContentItem',
      'WFAVAssetContentItem', 'WFPDFContentItem', 'WFPhoneNumberContentItem', 'WFRichTextContentItem',
      'WFSafariWebPageContentItem', 'WFStringContentItem', 'WFURLContentItem',
    ],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowImportQuestions: [
      {
        ActionIndex: ADDRESS_ACTION_INDEX,
        Category: 'Parameter',
        ParameterKey: 'WFTextActionText',
        Text: QUESTION,
        DefaultValue: '',
      },
    ],
    WFWorkflowActions: ACTIONS,
  };
}

// --- property list -----------------------------------------------------------

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistValue(value, indent) {
  const pad = '\t'.repeat(indent);
  if (typeof value === 'string') return `${pad}<string>${escapeXml(value)}</string>\n`;
  if (typeof value === 'boolean') return `${pad}<${value}/>\n`;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError('only whole numbers are used in the shortcut');
    return `${pad}<integer>${value}</integer>\n`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>\n`;
    return `${pad}<array>\n${value.map((v) => plistValue(v, indent + 1)).join('')}${pad}</array>\n`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}<dict/>\n`;
    const body = keys.map((key) => `${pad}\t<key>${escapeXml(key)}</key>\n${plistValue(value[key], indent + 1)}`).join('');
    return `${pad}<dict>\n${body}${pad}</dict>\n`;
  }
  throw new TypeError(`cannot write ${value} to a property list`);
}

/** The unsigned shortcut, as an XML property list. */
function buildShortcut() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${plistValue(shortcutDefinition(), 0)}</plist>\n`;
}

// --- signing -----------------------------------------------------------------

function main() {
  if (process.platform !== 'darwin') {
    console.error('The shortcut can only be signed on a Mac (it needs Apple\'s "shortcuts" tool).');
    process.exit(1);
  }
  const out = path.join(__dirname, '..', 'companion', 'web', ASSET_NAME);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-bridge-shortcut-'));
  try {
    const unsigned = path.join(work, `${SHORTCUT_NAME}.shortcut`);
    const signed = path.join(work, 'signed.shortcut');
    fs.writeFileSync(unsigned, buildShortcut());
    execFileSync('plutil', ['-lint', unsigned], { stdio: 'inherit' });
    execFileSync('plutil', ['-convert', 'binary1', unsigned]);
    execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signed], { stdio: 'inherit' });
    fs.copyFileSync(signed, out);
    fs.chmodSync(out, 0o644);
    console.log(`Signed shortcut written to ${out}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { buildShortcut, shortcutDefinition, SHORTCUT_NAME, ASSET_NAME, QUESTION, SEND_IF_PATTERN, HAS_ANY_VALUE };

if (require.main === module) main();
