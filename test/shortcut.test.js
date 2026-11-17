'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildShortcut, shortcutDefinition, ASSET_NAME, QUESTION, SEND_IF_PATTERN, HAS_ANY_VALUE,
} = require('../scripts/make-shortcut');

const definition = shortcutDefinition();
const actions = definition.WFWorkflowActions;
const byId = (id) => actions.find((a) => a.WFWorkflowActionIdentifier === id);

test('adding the shortcut asks for the address, and the answer lands in the address box', () => {
  assert.equal(definition.WFWorkflowImportQuestions.length, 1);
  const [question] = definition.WFWorkflowImportQuestions;
  assert.equal(question.Text, QUESTION);
  const asked = actions[question.ActionIndex];
  assert.equal(asked.WFWorkflowActionIdentifier, 'is.workflow.actions.gettext');
  assert.ok(question.ParameterKey in asked.WFWorkflowActionParameters);
  assert.equal(asked.WFWorkflowActionParameters[question.ParameterKey], '', 'no address is baked in');
});

test('the shortcut posts what it is given to that address, as {"message": ...}', () => {
  const address = byId('is.workflow.actions.gettext').WFWorkflowActionParameters;
  const send = byId('is.workflow.actions.downloadurl').WFWorkflowActionParameters;

  const target = send.WFURL.Value.attachmentsByRange['{0, 1}'];
  assert.equal(target.Type, 'ActionOutput');
  assert.equal(target.OutputUUID, address.UUID);

  assert.equal(send.WFHTTPMethod, 'POST');
  assert.equal(send.WFHTTPBodyType, 'JSON');
  const fields = send.WFJSONValues.Value.WFDictionaryFieldValueItems;
  assert.equal(fields.length, 1);
  assert.equal(fields[0].WFKey.Value.string, 'message');
  assert.equal(fields[0].WFValue.Value.attachmentsByRange['{0, 1}'].Type, 'ExtensionInput');
  assert.equal(definition.WFWorkflowHasShortcutInputVariables, true);
});

test('the shortcut looks at the message first and only sends one that could hold a code', () => {
  const ids = actions.map((a) => a.WFWorkflowActionIdentifier);
  const check = ids.indexOf('is.workflow.actions.text.match');
  const send = ids.indexOf('is.workflow.actions.downloadurl');
  const ifs = actions.map((a, i) => ({ i, p: a.WFWorkflowActionParameters }))
    .filter((x) => ids[x.i] === 'is.workflow.actions.conditional');
  assert.equal(ifs.length, 2, 'one If and its End If');
  const [opening, closing] = ifs;

  // Check, If, send, End If, in that order and with nothing else inside.
  assert.ok(check < opening.i, 'the check comes before the If');
  assert.equal(send, opening.i + 1);
  assert.equal(closing.i, send + 1);
  assert.equal(closing.i, actions.length - 1, 'nothing runs after the End If');

  const checking = actions[check].WFWorkflowActionParameters;
  assert.equal(checking.WFMatchTextPattern, SEND_IF_PATTERN);
  assert.equal(checking.text.Value.attachmentsByRange['{0, 1}'].Type, 'ExtensionInput', 'it looks at the message');

  assert.equal(opening.p.WFControlFlowMode, 0);
  assert.equal(opening.p.WFCondition, HAS_ANY_VALUE);
  assert.equal(opening.p.WFInput.Type, 'Variable');
  assert.equal(opening.p.WFInput.Variable.WFSerializationType, 'WFTextTokenAttachment');
  assert.deepEqual(opening.p.WFInput.Variable.Value, { Type: 'ActionOutput', OutputName: 'Matches', OutputUUID: checking.UUID });
  assert.equal(closing.p.WFControlFlowMode, 2);
  assert.equal(closing.p.GroupingIdentifier, opening.p.GroupingIdentifier);
});

test('the shortcut is written as a well-formed property list', (t) => {
  const xml = buildShortcut();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist /);
  assert.match(xml, /<\/plist>\n$/);
  assert.ok(xml.includes('<key>WFWorkflowActions</key>'));
  assert.ok(xml.includes('<string>\uFFFC</string>'), 'variables keep their placeholder character');
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(xml), 'no bare ampersand');
  for (const tag of ['dict', 'array', 'string', 'key']) {
    const opened = xml.split(`<${tag}>`).length - 1;
    const closed = xml.split(`</${tag}>`).length - 1;
    assert.equal(opened, closed, `<${tag}> is balanced`);
  }

  if (process.platform !== 'darwin') {
    t.diagnostic('plutil is only on a Mac; the system check was skipped');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-bridge-shortcut-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'unsigned.shortcut');
  fs.writeFileSync(file, xml);
  execFileSync('plutil', ['-lint', file]);
  // Read it back the way the system does, to be sure nothing was lost in writing.
  const back = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  assert.deepEqual(back, definition);
});

test('the signed shortcut the phone page offers is in the repository', () => {
  const file = path.join(__dirname, '..', 'companion', 'web', ASSET_NAME);
  const bytes = fs.readFileSync(file);
  // Files signed by Apple's tool are "Apple Encrypted Archives". An unsigned
  // property list here would be refused by every iPhone.
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'AEA1');
  assert.ok(bytes.length > 1000);
});
