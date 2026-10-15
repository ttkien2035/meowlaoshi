import test from 'node:test';
import assert from 'node:assert/strict';
import { endsSentence, SonioxClient } from './soniox.js';

test('endsSentence: Chinese and Latin marks, decimals', () => {
    assert.ok(endsSentence('真的吗？'));
    assert.ok(endsSentence('没得吃了。 '));
    assert.ok(endsSentence('Khoảng 0,68%.'));
    assert.ok(!endsSentence('如果你把所有的鸡蛋放在同一个篮子里，'));
    assert.ok(!endsSentence('tôi mua từ 550,'));
    assert.ok(!endsSentence('3.2'));
});

test('clauses show at once; a line stays open until the sentence ends', () => {
    const c = new SonioxClient();
    const ev = [];
    c.onOriginal = (t, _s, _l, append) => ev.push(['zh', t, append]);
    c.onTranslation = (t, append) => ev.push(['vi', t, append]);
    c.onProvisional = () => {};
    const tok = (text, s, f = true) => ({ text, translation_status: s, is_final: f });
    // Soniox sends a source clause, then its translation in the next message.
    c._handleResponse({ tokens: [tok('如果你把鸡蛋放在同一个篮子里，', 'original')] });
    c._handleResponse({ tokens: [tok(' nếu bạn cho trứng vào cùng một giỏ,', 'translation')] });
    c._handleResponse({ tokens: [tok('篮子倒了鸡蛋就破了。', 'original')] });
    c._handleResponse({ tokens: [tok(' giỏ đổ thì trứng vỡ.', 'translation')] });
    c._handleResponse({ tokens: [tok('一样的，', 'original')] });
    c._handleResponse({ tokens: [tok(' Tương tự,', 'translation')] });
    assert.deepEqual(ev, [
        ['zh', '如果你把鸡蛋放在同一个篮子里，', false],
        ['vi', ' nếu bạn cho trứng vào cùng một giỏ,', false],
        ['zh', '篮子倒了鸡蛋就破了。', true],
        ['vi', ' giỏ đổ thì trứng vỡ.', true],
        ['zh', '一样的，', false], // new line after the 。
        ['vi', ' Tương tự,', false],
    ]);
    // The translation line follows the source line's breaks, not its own punctuation.
    ev.length = 0;
    c._handleResponse({ tokens: [tok('对，是。', 'original')] });
    c._handleResponse({ tokens: [tok(' đúng vậy,', 'translation')] });
    c._handleResponse({ tokens: [tok('想到台积电我就觉得很开心，', 'original')] });
    c._handleResponse({ tokens: [tok(' nghĩ đến TSMC là tôi thấy rất vui.', 'translation')] });
    assert.deepEqual(ev.map((e) => e[2]), [true, true, false, false]);
    // <end> closes the open line, and the clause's late translation closes too.
    ev.length = 0;
    c._handleResponse({ tokens: [tok('好的，', 'original'), tok('<end>', 'original')] });
    c._handleResponse({ tokens: [tok(' Được,', 'translation')] });
    c._handleResponse({ tokens: [tok('那么，', 'original')] });
    c._handleResponse({ tokens: [tok(' Vậy thì,', 'translation')] });
    assert.deepEqual(ev.map((e) => e[2]), [true, true, false, false]);
    // A run-on sentence is cut at LINE_MAX_CHARS (80) at a clause boundary.
    ev.length = 0;
    for (let i = 0; i < 5; i++) {
        c._handleResponse({ tokens: [tok('这个评级公司呢它是一个公共产品啊，', 'original')] }); // 17 chars
        c._handleResponse({ tokens: [tok(' công ty xếp hạng này là sản phẩm công cộng,', 'translation')] });
    }
    c._handleResponse({ tokens: [tok('所以呢，', 'original')] });
    c._handleResponse({ tokens: [tok(' Vì vậy,', 'translation')] });
    assert.deepEqual(ev.filter((e) => e[0] === 'zh').map((e) => e[2]), [true, true, true, true, true, false]);
    assert.deepEqual(ev.filter((e) => e[0] === 'vi').map((e) => e[2]), [true, true, true, true, true, false]);
});
