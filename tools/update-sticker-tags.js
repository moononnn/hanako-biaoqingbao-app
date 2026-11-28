import { readMeta, writeMeta, enqueueToolWrite } from '../lib/shared.js';
import { rebuildStickerVector } from '../lib/sticker-vectors.js';
import { occasionSet } from '../lib/occasion-gate.js';

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "update_sticker_tags";
export const description = "修改已有表情包的标签（情绪、场景、关键词、描述、语义描述、限用场合）。只传要改的字段，没传的保持原样。什么时候用：用户说某张图标错了、归错类了；你发现某张图总被配到不合适的场合；用户让你重新认一遍图库。改之前先用 list_stickers 或 search_stickers 拿到 id，不要凭印象猜。新图入库走 add_sticker，不要用这个工具。改了语义描述会自动重建这张图的向量。";
export const parameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "表情包ID" },
    emotion: { type: "string", description: "情绪标签，多个用逗号分隔" },
    scene: { type: "string", description: "场景标签，多个用逗号分隔" },
    keywords: { type: "string", description: "关键词，多个用逗号分隔" },
    description: { type: "string", description: "新描述" },
    semantic_description: { type: "string", description: "语义描述，决定向量检索怎么找到这张图。改了会自动重建向量；传空字符串表示清空，旧向量一并删除。" },
    occasion: { type: "string", description: "限用场合，多个用逗号分隔，可选值只有早安、晚安、生日、节日、恭喜。只有画面文字把这张图钉死在某个场合时才填；填了它就只会在那个场合被选中。传空字符串表示取消限制。拿不准就别填。" }
  },
  required: ["id"]
};

export async function execute(input, ctx) {
  const { id, emotion, scene, keywords, description, semantic_description, occasion } = input || {};
  if (!id) return reply({ ok: false, error: '请提供表情包ID' });

  // 读改写进共用串行队列，和上传 / 删除 / 批量应用互斥，避免后写覆盖先写的更新。
  // 索引读取走 readMeta：索引损坏时抛可读错误，不再谎报「表情包库为空」。
  return await enqueueToolWrite(async () => {
    try {
      const stickers = readMeta();
      const idx = stickers.findIndex(s => s.id === id);
      if (idx === -1) return reply({ ok: false, error: `未找到ID为 "${id}" 的表情包` });

      const sticker = stickers[idx];
      // v0.8.0 - 语义描述变化后要重建向量，先留旧值用来比较
      const semanticBefore = sticker.semantic_description || '';

      if (emotion !== undefined) sticker.tags.emotion = emotion ? emotion.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (scene !== undefined) sticker.tags.scene = scene ? scene.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (keywords !== undefined) sticker.tags.keywords = keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (description !== undefined) sticker.description = description;
      if (semantic_description !== undefined) sticker.semantic_description = semantic_description;
      // v0.8.0 - 场合锁：只存词表内的组名；空值把锁摘掉，回到「任何场合都能用」
      if (occasion !== undefined) {
        const locked = [...occasionSet(occasion ? occasion.split(',') : [])];
        if (locked.length) sticker.occasion = locked;
        else delete sticker.occasion;
      }

      // v0.19.5 - 原子写，避免崩溃留下半截图库文件
      writeMeta(stickers);

      // v0.8.0 - 描述变了就重算向量：不重算的话新描述只在文件里，检索用的还是旧的那条。
      // 工具调用里同步等它，好把成败如实报给调用方；网络失败只当警告，不回滚标签。
      let vectorNote = '';
      if ((sticker.semantic_description || '') !== semanticBefore) {
        const rebuilt = await rebuildStickerVector(sticker, { ctx });
        vectorNote = rebuilt?.ok
          ? (rebuilt.removed ? '，旧向量已删除' : rebuilt.skipped ? '，向量未重建' : '，向量已按新描述重建')
          : `，向量重建失败：${rebuilt?.error || rebuilt?.skipped || '未知原因'}`;
      }

      return reply({ ok: true, data: sticker, message: `表情包「${sticker.description}」标签已更新${vectorNote}` });
    } catch (error) {
      const reason = error?.message || String(error);
      ctx?.log?.warn?.('[biaoqingbao] update_sticker_tags 失败:', reason);
      return reply({ ok: false, error: `更新标签失败：${reason}` });
    }
  });
}