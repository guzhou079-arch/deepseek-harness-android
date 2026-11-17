/**
 * dsh-plugin-food-card —— host 半边。
 *
 * 只做一件事：给 agent 注册一个 `food_card` 工具。工具本身不执行任何动作，
 * 执行结果就一句「展示了 N 张卡」；真正的渲染在客户端半边（toolview slot）。
 *
 * 为什么不塞进正文：DSH 的 markdown 渲染器明确禁用 raw HTML
 * （primitives/lib/index.js：raw HTML and unsafe protocols are disabled），
 * 而 toolview 是有官方缝的 —— `tool.call.toolview` 按工具名分发。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'food-card';
export const inject = ['tools'];

const itemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shop: { type: 'string', required: true, description: '店名' },
    dish: { type: 'string', required: true, description: '商品名' },
    spec: { type: 'string', description: '规格，如「大杯/正常冰/七分糖」' },
    price: { type: 'number', required: true, description: '现价（元）' },
    origin: { type: 'number', description: '原价（元），会画成划线价' },
    rating: { type: 'number', description: '评分，0-5' },
    delivery: { type: 'string', description: '预计送达，如「25分钟」' },
    distance: { type: 'string', description: '距离，如「1.2km」' },
    fee: { type: 'string', description: '配送费，如「免配送费」「配送¥3」' },
    note: { type: 'string', description: '一句话卖点' },
    tag: { type: 'string', description: '角标，如「免配送费」「新人价」' },
    sales: { type: 'string', description: '月售，如「月售3000+」' },
    image: { type: 'string', description: '商品图 URL（有就显示缩略图）' },
  },
};

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'food_card',
      description:
        '把外卖/到店推荐渲染成聊天里的卡片（只展示，不下单、不付款）。' +
        '用户要「推荐/挑一个/对比附近有什么」时调用，一个 item 一张卡；' +
        '卡片会直接出现在对话里，比纯文字表格好看，也便于用户点「选这个」。',
      parameters: {
        title: { type: 'string', description: '卡片组标题，如「附近的炸鸡」' },
        items: {
          type: 'array',
          required: true,
          description: '1-6 张卡，按推荐顺序排',
          items: itemSchema,
        },
        footer: { type: 'string', description: '底部提示，如「点「选这个」后回我一句就行」' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { count: { type: 'integer', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: `已在对话里展示 ${value.count} 张卡片。` }],
      },
      async execute(args) {
        return { count: Array.isArray(args.items) ? args.items.length : 0 };
      },
    }),
  );
}
