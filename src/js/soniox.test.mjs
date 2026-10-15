import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { endsSentence, SonioxClient } from './soniox.js';

const tok = (text, s, f = true) => ({ text, translation_status: s, is_final: f });

/** Run messages through the client and rebuild the on-screen lines from its callbacks. */
function replay(messages) {
    const c = new SonioxClient();
    const lines = [];
    c.onOriginal = (t, _s, _l, append) => {
        if (append) lines.at(-1).zh += t;
        else lines.push({ zh: t, vi: '' });
    };
    c.onTranslation = (t, append) => {
        const last = lines.at(-1);
        if (append || (last && !last.vi)) last.vi += t;
        else lines.push({ zh: '', vi: t });
    };
    c.onProvisional = () => {};
    for (const tokens of messages) c._handleResponse({ tokens });
    return lines;
}

test('endsSentence: Chinese and Latin marks, decimals', () => {
    assert.ok(endsSentence('真的吗？'));
    assert.ok(endsSentence('没得吃了。 '));
    assert.ok(endsSentence('Khoảng 0,68%.'));
    assert.ok(!endsSentence('如果你把所有的鸡蛋放在同一个篮子里，'));
    assert.ok(!endsSentence('3.2'));
});

test('clauses join one line; the line closes only after its translation', () => {
    const lines = replay([
        [tok('如果你把鸡蛋放在同一个篮子里，', 'original')],
        [tok(' nếu bạn cho trứng vào cùng một giỏ,', 'translation')],
        [tok('篮子倒了鸡蛋就破了。', 'original')],
        [tok(' giỏ đổ thì trứng vỡ.', 'translation')],
        [tok('一样的，', 'original')],
        [tok(' Tương tự,', 'translation')],
    ]);
    assert.deepEqual(lines, [
        { zh: '如果你把鸡蛋放在同一个篮子里，篮子倒了鸡蛋就破了。', vi: ' nếu bạn cho trứng vào cùng một giỏ, giỏ đổ thì trứng vỡ.' },
        { zh: '一样的，', vi: ' Tương tự,' },
    ]);
});

test('one translation for several clauses stays on their line (the v1.2.1 drift)', () => {
    const lines = replay([
        [tok('这也就是道德风险机制。', 'original')],
        [tok('本部分讨论的所有政策工具，', 'original')], // arrives before the first translation
        [tok(' Đó là cơ chế rủi ro đạo đức. Tất cả công cụ chính sách,', 'translation')],
        [tok('本质上都是在硬化这一软约束。', 'original')],
        [tok(' về bản chất đều cứng hóa ràng buộc mềm này.', 'translation')],
        [tok('限额管理。', 'original')],
        [tok(' Quản lý hạn mức.', 'translation')],
    ]);
    assert.deepEqual(lines.map((l) => [l.zh, l.vi.trim()]), [
        ['这也就是道德风险机制。本部分讨论的所有政策工具，本质上都是在硬化这一软约束。',
            'Đó là cơ chế rủi ro đạo đức. Tất cả công cụ chính sách, về bản chất đều cứng hóa ràng buộc mềm này.'],
        ['限额管理。', 'Quản lý hạn mức.'],
    ]);
});

test('<end> closes the line once translated, whichever comes first', () => {
    const lines = replay([
        [tok('好的，', 'original')], [tok('<end>', 'none')], [tok(' Được,', 'translation')],
        [tok('那么，', 'original')], [tok(' Vậy thì,', 'translation')], [tok('<end>', 'none')],
        [tok('接下来，', 'original')], [tok(' Tiếp theo,', 'translation')],
    ]);
    assert.deepEqual(lines.map((l) => l.zh), ['好的，', '那么，', '接下来，']);
    assert.deepEqual(lines.map((l) => l.vi.trim()), ['Được,', 'Vậy thì,', 'Tiếp theo,']);
});

test('a run-on sentence breaks after 80 characters, at a translation', () => {
    const msgs = [];
    for (let i = 0; i < 6; i++) {
        msgs.push([tok('这个评级公司呢它是一个公共产品啊，', 'original')]); // 17 chars
        msgs.push([tok(' công ty xếp hạng này là sản phẩm công cộng,', 'translation')]);
    }
    const lines = replay(msgs);
    assert.deepEqual(lines.map((l) => l.zh.length), [85, 17]);
    assert.ok(lines.every((l) => l.vi.split(',').length - 1 === l.zh.split('，').length - 1));
});

// Real Soniox output (final tokens, 5 min each, 2026-10-15). Every line must
// carry its own translation: same number of sentences on both sides, except
// where the Vietnamese turns a "，" into "?" or "..." (≤ 2 per lecture).
for (const name of ['taiwan-investment', 'mainland-politics', 'mainland-local-debt']) {
    test(`real lecture ${name}: every line pairs with its translation, nothing lost`, () => {
        const raw = JSON.parse(readFileSync(new URL(`./fixtures/soniox-${name}.json`, import.meta.url), 'utf8'));
        const status = { o: 'original', t: 'translation', n: 'none' };
        const messages = raw.map((m) => m.map(([text, s]) => tok(text, status[s])));
        const lines = replay(messages);
        const zs = (t) => (t.match(/[。！？]/g) || []).length;
        const vs = (t) => (t.match(/[.!?…]+(?=["”»)]*(\s|$))/g) || []).length;
        const off = lines.filter((l) => zs(l.zh) !== vs(l.vi));
        assert.ok(off.length <= 2, `${off.length} lines out of step:\n${off.slice(0, 3).map((l) => `${l.zh}\n${l.vi}`).join('\n')}`);
        assert.ok(lines.every((l) => l.zh && l.vi.trim()), 'a line without one side');
        const all = (k) => messages.flat().filter((t) => t.text !== '<end>' && (t.translation_status === 'translation') === (k === 'vi')).map((t) => t.text).join('');
        assert.equal(lines.map((l) => l.zh).join(''), all('zh'));
        assert.equal(lines.map((l) => l.vi).join(''), all('vi'));
    });
}
