import { mkdir, readFile, unlink } from 'node:fs/promises';
import { genId, readMeta, writeMeta, writeNewStickerFile, enqueueToolWrite, STICKERS_DIR } from '../lib/shared.js';
import { safeStickerPath } from '../lib/ball-core.js';

const stickersDir = STICKERS_DIR;

const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "add_sticker";
export const description = "把一张新图收进图库。sourcePath 传本机绝对路径，插件会复制图片到库目录并记录元数据。emotion / scene / keywords 尽量填，图库靠它们检索，空着的图以后很难被选中；description 写一句话说明这张图的感觉。什么时候用：用户明确让你把某张图收进库（「这张留着以后用」「加进图库」），或者你找到一张值得留的图并且用户认可。什么时候别用：用户只是发张图和你聊天、没说要收藏，不要自动入库。入库以后要改标签走 update_sticker_tags，不要删了重加。";
export const parameters = {
  type: "object",
  properties: {
    sourcePath: { type: "string", description: "图片文件的本地绝对路径" },
    emotion: { type: "string", description: "情绪标签，多个用逗号分隔，如 '开心,感动,可爱'" },
    scene: { type: "string", description: "场景标签，多个用逗号分隔，如 '早安,恭喜,打气'" },
    keywords: { type: "string", description: "关键词，多个用逗号分隔" },
    description: { type: "string", description: "一句话描述这张表情包的感觉" }
  },
  required: ["sourcePath"]
};

export async function execute(input, ctx) {
  const { sourcePath, emotion = '', scene = '', keywords = '', description = '' } = input || {};

  if (!sourcePath) return reply({ ok: false, error: '请提供图片路径' });

  const normalizedPath = sourcePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const originalFile = parts[parts.length - 1];
  const ext = originalFile.split('.').pop().toLowerCase();

  if (!ALLOWED_EXTS.includes(ext)) {
    return reply({ ok: false, error: `不支持的文件格式: .${ext}，支持: ${ALLOWED_EXTS.join(', ')}` });
  }

  // v0.25.2 - 分配 id → 复制 → 写 meta 整体进串行队列：多会话并发调用时不会分配到同一个 id
  // 索引读取走 readMeta：索引损坏或缺失时直接抛错，绝不再当成「空库」把整库元数据覆盖掉。
  return await enqueueToolWrite(async () => {
    let destPath = '';
    let created = false;
    try {
      const stickers = readMeta();
      const id = genId(stickers);
      const fileName = `${id}.${ext}`;
      destPath = safeStickerPath(stickersDir, fileName);
      if (!destPath) return reply({ ok: false, error: '图库目录路径不安全，无法写入图片' });

      let buffer;
      try {
        buffer = await readFile(sourcePath);
      } catch (e) {
        return reply({ ok: false, error: `读取源文件失败: ${e.message}` });
      }
      if (!buffer.length) return reply({ ok: false, error: `源文件是空的: ${originalFile}` });

      await mkdir(stickersDir, { recursive: true });
      // 排他创建：编号已被磁盘上的旧图占用时直接失败，不会覆盖别人的图。
      writeNewStickerFile(destPath, buffer);
      created = true;

      const entry = {
        id,
        file: fileName,
        description: description || originalFile.replace(`.${ext}`, ''),
        tags: {
          emotion: emotion ? emotion.split(',').map(s => s.trim()).filter(Boolean) : [],
          scene: scene ? scene.split(',').map(s => s.trim()).filter(Boolean) : [],
          keywords: keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : []
        },
        added_at: new Date().toISOString()
      };

      stickers.push(entry);
      // v0.19.5 - 原子写，避免崩溃留下半截图库文件
      writeMeta(stickers);
      created = false;

      ctx?.log?.info?.(`[biaoqingbao] add_sticker 入库: ${id} (${fileName})`);
      return reply({ ok: true, data: entry, message: `已添加表情包 ${id}` });
    } catch (error) {
      // 只有本轮确实创建出来的文件才允许清理；元数据没落盘就不留半张孤儿图在库里。
      if (created && destPath) {
        try { await unlink(destPath); } catch {}
      }
      const reason = error?.message || String(error);
      ctx?.log?.warn?.('[biaoqingbao] add_sticker 入库失败:', reason);
      if (error?.code === 'EEXIST') {
        return reply({ ok: false, error: `图库里已经有 ${error.path || destPath}，入库已中止，原图未被改动。` });
      }
      return reply({ ok: false, error: `入库失败：${reason}` });
    }
  });
}
