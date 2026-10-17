# Demo photos · 无人物示例数据集

这里是从作者自己的照片库里挑出的 **10 张没有人物** 的照片，用来在没有任何私人照片的情况下试用 Wallflow。

| 文件 | 内容 | 分类 |
| --- | --- | --- |
| `animal-heron.jpg` | 夜鹭 | 动物 |
| `animal-giraffe.jpg` | 长颈鹿 | 动物 |
| `animal-warthog.jpg` | 荒野动物 | 动物 |
| `animal-birds.jpg` | 两只鸟 | 动物 |
| `landscape-lake.jpg` | 高原湖泊 | 风景 |
| `landscape-grassland.jpg` | 草原 | 风景 |
| `landscape-wetland.jpg` | 湿地 | 风景 |
| `landscape-fields.jpg` | 田野 | 风景 |
| `urban-night.jpg` | 夜色老街 | 城市 |
| `urban-cafe.jpg` | 咖啡馆一角 | 城市 |

## License

这些照片由 **Wallflow contributors** 提供，采用
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权。
转载或再分发时请保留署名和本文件中的来源信息。逐张信息见 `credits.json`。

> 代码本身仍是 MIT；图片单独采用 CC BY 4.0。

## 试用

在仓库根目录执行：

```bash
npm run demo:scan   # 只扫描这 10 张，不调用模型、不花钱
npm run demo        # 打开 http://127.0.0.1:7800
```

Demo 使用：

- 配置：`demo/config.json`
- 数据目录：`demo-data/`（已 gitignore，不会动你的 `data/` 和 `config.json`）
- 端口：`7800`（不和主实例的 7799 冲突）
- 每日预算：默认 ¥2.00，可在 Demo 设置页里调整

要生成成片，需要先按主 README 配好 `.secrets/volcengine.env`。

Demo 会实际修改桌面/锁屏壁纸；恢复用：

```bash
npm run demo:restore
```

删除 `demo-data/` 即可把 Demo 的状态完全清空。
