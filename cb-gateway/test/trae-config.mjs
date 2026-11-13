import assert from 'node:assert/strict';

const { parseTraeConfig } = await import('../src/channels/trae/config.ts');
const { contextOptions } = await import('../src/channels/trae/index.ts');

const contact = (rate, access = [0, 5, 1, 2, 3, 100]) =>
  JSON.stringify({
    access: { data: { identity_list: access } },
    ...(rate === null ? {} : { consumption_rate: { data: { rate } } }),
  });

const entry = (overrides) => ({
  config_name: 'model-x',
  config_switch: true,
  is_invisible_to_user: false,
  context_window_tokens: { dev: 200000, max: 1000000 },
  display_config: { display_name: 'Model X', model_capability: 'reasoning_model', is_custom_model: false },
  display_contact_config: contact(0.5),
  model_detail_list: [{ max_tokens: 32000 }],
  ...overrides,
});

const doc = (infos) => ({ function_configs: [{ function: 'solo_agent', config_info_list: infos }] });

let pass = 0;
let fail = 0;
function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const good = parseTraeConfig(doc([entry({ config_name: 'glm-5.3', display_config: { display_name: 'GLM-5.3', model_capability: 'reasoning_model' }, display_contact_config: contact(0.78) })]));
check('正常模型被收进来', good.length, 1);
check('id 用 config_name', good[0].id, 'glm-5.3');
check('上下文取 dev 而不是 max', good[0].contextWindow, 200000);
check('max 上下文单独留一份', good[0].maxContext, 1000000);
check('最大输出取 model_detail_list', good[0].maxTokens, 32000);
check('倍率解析出来', good[0].rate, 0.78);
check('推理能力来自 model_capability', good[0].reasoning, true);

{
  const two = entry({
    config_name: 'deepseek-v4.1-flash',
    display_config: { display_name: 'DeepSeek-V4.1-Flash', model_capability: 'reasoning_model' },
    model_detail_list: [
      { model_name: 'deepseek-v4.1-flash__max', max_tokens: 64000, prompt_max_tokens: 936000 },
      { model_name: 'deepseek-v4.1-flash__dev', max_tokens: 32000, prompt_max_tokens: 168000 },
    ],
  });
  const parsed = parseTraeConfig(doc([two]));
  check('顺序反过来也挑 __dev（不是靠下标）', parsed[0].maxTokens, 32000);

  const devFirst = entry({
    config_name: 'x',
    display_config: { display_name: 'X', model_capability: 'reasoning_model' },
    model_detail_list: [
      { model_name: 'x__dev', max_tokens: 16000 },
      { model_name: 'x__max', max_tokens: 64000 },
    ],
  });
  check('__dev 在前同样正确', parseTraeConfig(doc([devFirst]))[0].maxTokens, 16000);

  const noSuffix = entry({
    config_name: 'y',
    display_config: { display_name: 'Y', model_capability: 'reasoning_model' },
    model_detail_list: [{ max_tokens: 8000 }],
  });
  check('没有 __dev 后缀时退回第一条（老配置兼容）', parseTraeConfig(doc([noSuffix]))[0].maxTokens, 8000);

  check('留下 __dev 变体名', parsed[0].devModelName, 'deepseek-v4.1-flash__dev');
  check('留下 __max 变体名', parsed[0].maxModelName, 'deepseek-v4.1-flash__max');
  check('留下 __max 的输出上限', parsed[0].maxTokensMax, 64000);

  const devOnly = entry({
    config_name: 'z',
    display_config: { display_name: 'Z', model_capability: 'reasoning_model' },
    model_detail_list: [{ model_name: 'z__dev', max_tokens: 16000 }],
  });
  check('没有 __max 时 maxModelName 为 null', parseTraeConfig(doc([devOnly]))[0].maxModelName, null);
  check('没有 __max 时 maxTokensMax 为 null', parseTraeConfig(doc([devOnly]))[0].maxTokensMax, null);
}

{
  const withMm = entry({
    config_name: 'mm',
    display_config: { display_name: 'MM', model_capability: 'reasoning_model', multimodal: true },
  });
  check('multimodal=true 被解析出来', parseTraeConfig(doc([withMm]))[0].multimodal, true);

  const noMm = entry({
    config_name: 'plain',
    display_config: { display_name: 'Plain', model_capability: 'reasoning_model', multimodal: false },
  });
  check('multimodal=false 保留为 false', parseTraeConfig(doc([noMm]))[0].multimodal, false);

  const missingMm = entry({
    config_name: 'old',
    display_config: { display_name: 'Old', model_capability: 'reasoning_model' },
  });
  check('缺 multimodal 字段时按 false（不崩）', parseTraeConfig(doc([missingMm]))[0].multimodal, false);
}

check('config_switch=false 剔掉', parseTraeConfig(doc([entry({ config_switch: false })])).length, 0);
check('is_invisible_to_user 剔掉', parseTraeConfig(doc([entry({ is_invisible_to_user: true })])).length, 0);
check('is_custom_model 剔掉', parseTraeConfig(doc([entry({ display_config: { display_name: 'X', is_custom_model: true } })])).length, 0);
check('会员专享（access 不含 0）剔掉', parseTraeConfig(doc([entry({ display_contact_config: contact(0.5, [5, 1, 2, 3, 100]) })])).length, 0);
check('没有倍率的占位项剔掉', parseTraeConfig(doc([entry({ display_contact_config: contact(null) })])).length, 0);
check('没有 display_name 剔掉', parseTraeConfig(doc([entry({ display_config: { display_name: '', model_capability: 'reasoning_model' } })])).length, 0);
check('没有 max_tokens 剔掉', parseTraeConfig(doc([entry({ model_detail_list: [] })])).length, 0);

check('重复 id 去重', parseTraeConfig(doc([entry({}), entry({})])).length, 1);

const fallback = parseTraeConfig(doc([entry({ context_window_tokens: {} })]));
check('缺 dev 时上下文兜底 200000', fallback[0].contextWindow, 200000);
check('缺 max 时 maxContext 为 null', fallback[0].maxContext, null);

check('空 doc 返回空数组', parseTraeConfig({}), []);
check('function_configs 不是数组也不炸', parseTraeConfig({ function_configs: null }), []);

check('200K 模型的档位', contextOptions(200000), [100000, 150000, 200000]);
check('256K 模型的档位', contextOptions(256000), [128000, 192000, 256000]);
check('最高一档等于模型上限（不越过实测值）', contextOptions(200000).at(-1), 200000);
check('档位升序', JSON.stringify(contextOptions(200000)), JSON.stringify([...contextOptions(200000)].sort((a, b) => a - b)));
check('上限极小时不产生重复档位', contextOptions(20000).length, new Set(contextOptions(20000)).size);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
process.exitCode = fail === 0 ? 0 : 1;
