/**
 * Style presets. Prompts are written in Chinese because Seedream follows
 * Chinese art-direction instructions very well, and they deliberately
 * repeat "keep the composition / subject" so the photo stays recognisable.
 */

export const STYLES = [
  {
    id: 'watercolor',
    name: '水彩',
    en: 'Watercolor',
    emoji: '🫧',
    accent: '#7cc6b0',
    hint: '透明水色、纸纹肌理、边缘自然晕开',
    prompt:
      '将这张照片重绘为一幅高品质水彩画：透明水色层层叠染，纸张纤维肌理清晰，颜料在边缘自然晕开，留白透气，色调清新柔和，光线通透。',
  },
  {
    id: 'ghibli',
    name: '吉卜力',
    en: 'Ghibli',
    emoji: '🌿',
    accent: '#8fc98a',
    hint: '动画电影质感、柔和光影、通透天空',
    prompt:
      '将这张照片转成吉卜力动画电影风格：手绘动画质感，柔和的自然光影，通透的蓝天与蓬松云朵，植物细节丰富，色彩温暖治愈，有电影镜头感。',
  },
  {
    id: 'oil',
    name: '油画',
    en: 'Oil painting',
    emoji: '🎨',
    accent: '#d9a066',
    hint: '厚涂笔触、古典光影、浓郁色层',
    prompt:
      '将这张照片转为古典油画风格：可见的厚涂笔触与画布肌理，伦勃朗式的侧光与明暗对比，色彩浓郁沉稳，笔触松弛有度，像博物馆里的原作。',
  },
  {
    id: 'ink',
    name: '水墨',
    en: 'Ink wash',
    emoji: '🖌️',
    accent: '#9aa7b5',
    hint: '宣纸留白、墨色浓淡、东方气韵',
    prompt:
      '将这张照片转成中国水墨画风格：宣纸质感与自然留白，墨色浓淡干湿变化丰富，线条写意流畅，局部点以极淡的赭石或花青色，意境悠远。',
  },
  {
    id: 'film',
    name: '胶片',
    en: 'Film',
    emoji: '🎞️',
    accent: '#c9a27e',
    hint: '胶片颗粒、柔和褪色、温暖高光',
    prompt:
      '将这张照片处理成 1990 年代胶片摄影风格：细腻的胶片颗粒，柔和的高光与轻微褪色，偏暖的色调，宽容度高的暗部，像用 Portra 400 拍出的质感，保持真实摄影感。',
  },
  {
    id: 'riso',
    name: 'Riso 版画',
    en: 'Risograph',
    emoji: '🖨️',
    accent: '#d08c6e',
    hint: '扁平色块、米黄纸底、颗粒纸纹、低饱和拼贴',
    preserve: {
      person: '保留人物可辨识的轮廓、发型、服装与姿态，用扁平色块概括，不追求写实',
      animal: '保留动物可辨识的轮廓与主要花纹，用扁平色块概括',
      landscape: '保留地形、天空与建筑的相对位置，用大块纯色概括',
      urban: '保留建筑轮廓、街道走向与招牌位置，用扁平色块概括',
      other: '保留主体的可辨识轮廓，用扁平色块概括',
    },
    prompt:
      '将这张照片重绘为 Riso 印刷版画拼贴风格：把主体简化为扁平色块造型，轮廓简约，去掉照片写实光影与细节，用大块低饱和纯色概括环境；米黄色复古做旧纸底，粗糙纸张肌理与颗粒纸纹，类似孔版印刷的轻微套色错位与墨色不均；少量极简装饰元素，留白充足，安静、治愈、文艺，艺术海报质感；平面插画，拼贴构图，不写实，无多余细节。',
  },
  {
    id: 'ukiyoe',
    name: '浮世绘',
    en: 'Ukiyo-e',
    emoji: '🌊',
    accent: '#e08a6a',
    hint: '木版画线条、平涂色块、和风构图',
    prompt:
      '将这张照片转成日本浮世绘木版画风格：清晰的墨线轮廓，平面化的色块平涂，靛蓝、朱红与米黄的经典配色，纸张纹理，构图带有北斋式的装饰感。',
  },
  {
    id: 'minimal',
    name: '极简插画',
    en: 'Minimal',
    emoji: '◻️',
    accent: '#8fb3d9',
    hint: '大色块、克制配色、留白构图',
    prompt:
      '将这张照片转成极简主义扁平插画：高度概括的几何形状，克制的三到四种配色，大面积留白，干净的边缘，没有多余细节，现代海报般的构图。',
  },
  {
    id: 'pixel',
    name: '像素艺术',
    en: 'Pixel art',
    emoji: '👾',
    accent: '#f0a3c0',
    hint: '16-bit 像素、复古游戏、有限色板',
    prompt:
      '将这张照片转成精致的 16-bit 像素艺术：清晰的像素颗粒，有限的复古色板，像素化的光影过渡，像经典游戏场景，构图保持不变。',
  },
  {
    id: 'surreal',
    name: '梦境',
    en: 'Dreamlike',
    emoji: '🌙',
    accent: '#9d8bd8',
    hint: '超现实、柔焦、梦幻光尘',
    prompt:
      '将这张照片转成超现实梦境风格：柔焦与薄雾，漂浮的光尘与细微的光斑，色彩介于现实与幻想之间，安静而诗意，保留原场景的可辨识结构。',
  },
];

export const STYLE_MAP = new Map(STYLES.map((s) => [s.id, s]));

const CATEGORY_PRESERVE = {
  person:
    '严格保留人物的面部特征、五官比例、发型、肤色与服装款式，不要改变长相和身份；人物在画面中的位置与姿态保持不变',
  animal:
    '严格保留动物的形态、毛色、斑纹、眼神与姿态细节，不要替换成别的物种',
  landscape:
    '保留地形起伏、山脊线、天空与云层的走向、水面与建筑的相对位置，不要凭空添加主体',
  urban:
    '保留建筑结构、街道走向、招牌位置与透视关系，不要改变城市空间的布局',
  other: '保持主体清晰可辨，位置与姿态不变',
};

export const NEGATIVE_SUFFIX =
  '不要添加任何文字、字幕、水印、签名、边框或画框；不要出现多余的人物或动物；画面干净完整，适合作为 16:9 桌面壁纸。';

export function styleById(id) {
  return STYLE_MAP.get(id) ?? null;
}

export function enabledStyles(config) {
  const ids = config.styles?.enabled ?? [];
  return ids.map(styleById).filter(Boolean);
}

export function buildPrompt(styleId, category = 'other', config) {
  const style = styleById(styleId);
  if (!style) throw new Error(`未知风格：${styleId}`);
  const custom = config?.styles?.custom?.[styleId]?.trim();
  const base = custom || style.prompt;
  const preserve = style.preserve?.[category] ?? CATEGORY_PRESERVE[category] ?? CATEGORY_PRESERVE.other;
  return `${base}\n画面要求：${preserve}。${NEGATIVE_SUFFIX}`;
}

/** Short human-readable prompt for the UI (first line only). */
export function promptPreview(styleId, config) {
  const style = styleById(styleId);
  const custom = config?.styles?.custom?.[styleId];
  return (custom || style?.hint || '').trim();
}
