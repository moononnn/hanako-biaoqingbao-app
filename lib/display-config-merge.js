// 显示/纸飞机这类全局资产在导入搬家包时的合并规则。
//
// 背景：迁移包是来源机的一份快照，导入时按「整份覆盖」处理。
// 但显示配置里有几个键是**本机用户亲手拨过的总闸**——
// 输入栏表情按钮（inputButton；2026-10-29 起聊天页与 Code 页分开记：
// inputButtonChat / inputButtonCode，旧键 inputButton 只当镜像）和伙伴配图自评（agentSelfNote）。
// 整份覆盖会把它们抹掉：键消失后读的时候按默认值算，
// 于是用户明明关掉了，导入一个旧包之后按钮又冒出来、伙伴又开始自己给自己配图打分，
// 而且全程没有任何提示。这两个键留在本机，不随包走。
//
// 抽成独立模块是为了能单独测这条规则：它守的是「不许静默改用户的开关」。

const LOCAL_SWITCHES = ['inputButton', 'inputButtonChat', 'inputButtonCode', 'agentSelfNote'];

// 本机从没动过这个开关时，读取侧按这个默认值算生效值。
// 保留总闸时必须用同一套默认值，否则会出现反向的静默改设置：
// 本机从没动过（生效 true）+ 包里带 inputButton:false → 导入后按钮被静默关掉。
const EFFECTIVE_DEFAULTS = { inputButton: true, inputButtonChat: true, inputButtonCode: true, agentSelfNote: true };

function effectiveLocalValue(base, key) {
  return typeof base[key] === 'boolean' ? base[key] : EFFECTIVE_DEFAULTS[key];
}

export function mergeDisplayConfig(current, incoming) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  // 包里的字段覆盖本机同名字段，本机独有的字段保留。
  const merged = { ...base, ...next };
  // 本机总闸始终以本机的生效值为准（包里的旧快照带不回来）。
  // 包里没带这两个键时不往配置文件里造键；
  // 包里带了（哪怕是脏值，比如字符串 "false"、null）也一律按本机生效值处理：
  // 读取侧认的是 `!== false`，一个字符串 "false" 在那边会被当成 true，
  // 放着不管就等于本机关着的开关被静默打开。
  for (const key of LOCAL_SWITCHES) {
    if (next[key] === undefined) continue;
    merged[key] = effectiveLocalValue(base, key);
  }
  return merged;
}

// 迁移包里的这两个总闸和本机不一样（说明包里带的是另一台机器或更早时候的值）。
// 合并时会保留本机的，所以这个差异要在导入回执里如实说出来，不能默默吞掉。
export function displayConfigSwitchesDiffer(current, incoming) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  return LOCAL_SWITCHES.some(key => {
    if (next[key] === undefined) return false;
    // 包里带了个不能当开关用的值：它会被忽略、按本机生效值处理，
    // 本机有明确设置时值得说一句。
    if (typeof next[key] !== 'boolean') return typeof base[key] === 'boolean';
    // 本机没这个键时按生效默认值比，不然这条差异会被漏掉。
    return effectiveLocalValue(base, key) !== next[key];
  });
}

export { LOCAL_SWITCHES };
