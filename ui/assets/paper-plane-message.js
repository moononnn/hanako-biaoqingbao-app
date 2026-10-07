// 对话内的图片卡 —— 用户丢的图和伙伴配的图共用这一张（v0.1.33 起合并，原 partner-sticker-message 那张已删）。
// 视图逻辑在 message-card-view.js 里；配文只在用户丢图时显示，伙伴配的图由记录的 sender 决定不配文。
import { mountMessageCard } from './message-card-view.js';

mountMessageCard({ showCaption: true });
