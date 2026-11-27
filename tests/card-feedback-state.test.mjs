// v0.7.7 - 卡片反馈四态转换：positive / negative（整图降权）/ misfit（只压这个场景）/ null。
// 这套转换是账本的前提：先确定点完是什么态，再按状态差去撤账、记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCardFeedbackState } from '../lib/ball-message-card.js';

const S = (feedback, kind = null) => ({ feedback, kind });

test('空态点三键：各落各的态，一次点击一步到位', () => {
  assert.deepEqual(nextCardFeedbackState(null, null, 'image'), S('positive', 'image'));
  assert.deepEqual(nextCardFeedbackState(null, null, 'context'), S('positive', 'context'));
  assert.deepEqual(nextCardFeedbackState(null, null, 'negative'), S('negative'));
  assert.deepEqual(nextCardFeedbackState(null, null, 'misfit'), S('misfit'));
});

test('同维度再点一次 = 取消', () => {
  assert.deepEqual(nextCardFeedbackState('negative', null, 'negative'), S(null));
  assert.deepEqual(nextCardFeedbackState('misfit', null, 'misfit'), S(null));
  assert.deepEqual(nextCardFeedbackState('positive', 'image', 'image'), S(null));
  assert.deepEqual(nextCardFeedbackState('positive', 'context', 'context'), S(null));
});

test('整图降权和场景负向是同一根轴上的两档，可以来回切', () => {
  // 点了不喜欢觉得只是场合不对：降成场景账
  assert.deepEqual(nextCardFeedbackState('negative', null, 'misfit'), S('misfit'));
  // 又觉得这图确实不行：升回整图
  assert.deepEqual(nextCardFeedbackState('misfit', null, 'negative'), S('negative'));
});

test('负向两档可以改成正向，正向也能被打回负向', () => {
  assert.deepEqual(nextCardFeedbackState('misfit', null, 'image'), S('positive', 'image'));
  assert.deepEqual(nextCardFeedbackState('negative', null, 'context'), S('positive', 'context'));
  assert.deepEqual(nextCardFeedbackState('positive', 'context', 'negative'), S('negative'));
  assert.deepEqual(nextCardFeedbackState('positive', 'both', 'misfit'), S('misfit'));
});

test('正向两档叠加不变：image 加 context 变 both，both 再点某维度只剩另一维度', () => {
  assert.deepEqual(nextCardFeedbackState('positive', 'image', 'context'), S('positive', 'both'));
  assert.deepEqual(nextCardFeedbackState('positive', 'both', 'image'), S('positive', 'context'));
  assert.deepEqual(nextCardFeedbackState('positive', 'both', 'context'), S('positive', 'image'));
});

test('旧记录没有 feedbackKind 时按 image 处理，不抛错', () => {
  assert.deepEqual(nextCardFeedbackState('positive', undefined, 'image'), S(null));
  assert.deepEqual(nextCardFeedbackState('positive', '', 'context'), S('positive', 'both'));
});