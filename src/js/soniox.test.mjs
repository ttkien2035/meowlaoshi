import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, SonioxClient } from './soniox.js';

test('splitSentences: Chinese marks, decimals, remainder, flush-all', () => {
    assert.deepEqual(splitSentences('真的吗？买台积电好吗？还是', false), [['真的吗？', '买台积电好吗？'], '还是']);
    assert.deepEqual(splitSentences('大概是0.68%。所以乘以12，大概8%。', false), [['大概是0.68%。', '所以乘以12，大概8%。'], '']);
    assert.deepEqual(splitSentences('Khoảng 0,68%. Nhân 12 là 8%. Vậy', false), [['Khoảng 0,68%.', 'Nhân 12 là 8%.'], 'Vậy']);
    assert.deepEqual(splitSentences('Vậy', true), [['Vậy'], '']);
    assert.deepEqual(splitSentences('  ', true), [[], '']);
});

test('finals are shown per sentence and translations pair with shown sources', () => {
    const c = new SonioxClient();
    const ev = [];
    c.onOriginal = (t) => ev.push(['zh', t]);
    c.onTranslation = (t) => ev.push(['vi', t]);
    c.onProvisional = (t) => ev.push(['prov', t]);
    const tok = (text, s, f = true) => ({ text, translation_status: s, is_final: f });
    // Two batches make one sentence: no line until the 。
    c._handleResponse({ tokens: [tok('买台积电', 'original'), tok('好', 'original', false)] });
    assert.deepEqual(ev, [['prov', '买台积电好']]);
    c._handleResponse({ tokens: [tok('好吗？还是', 'original')] });
    assert.deepEqual(ev.at(-2), ['zh', '买台积电好吗？']);
    assert.deepEqual(ev.at(-1), ['prov', '还是']);
    // A translation with two sentences for one shown source: the second waits.
    c._handleResponse({ tokens: [tok('Mua TSMC tốt không? Hay là.', 'translation')] });
    assert.deepEqual(ev.filter((e) => e[0] === 'vi'), [['vi', 'Mua TSMC tốt không?']]);
    c._handleResponse({ tokens: [tok('NVIDIA？', 'original')] });
    assert.deepEqual(ev.filter((e) => e[0] !== 'prov').slice(-2), [['zh', '还是NVIDIA？'], ['vi', 'Hay là.']]);
    // <end> flushes an open source sentence and clears the provisional text.
    c._handleResponse({ tokens: [tok('好的', 'original'), tok('<end>', 'original')] });
    assert.deepEqual(ev.slice(-2), [['zh', '好的'], ['prov', '']]);
});
