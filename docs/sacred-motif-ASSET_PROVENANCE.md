# 资产来源与权利说明

## 用户提供的参考

- `assets/reference/bird-scene-original.png`：本轮用户上传的 1914×822 鸟群蓝图截图，字节复制保存，没有对这个文件做裁切或滤镜处理。
- `assets/reference/bird-scene-source.svg`：一个使用 `<image>` 嵌入相邻原始 PNG 的 SVG viewport wrapper。它只用于在 SVG viewport 中保持原图呈现，不是纯向量路径描摹。
- `assets/reference/bird-scene-transparent-overlay.png`：以用户截图中的低饱和底色与钴蓝线稿差异生成 alpha 的装饰图层；左侧 180px 区域被排除以避免移动装饰层把大块左侧色板覆盖/带动。轮廓来源于截图，颜色统一为系统钴蓝，属于处理版而非逐像素原图。

## 本包原创绘制的辅助纹样

以下文件基于用户给出的艺术方向自行绘制，不是 PV 官方素材，也不复制官方徽标/角色设计：
- `assets/birds/bird-pose-library.svg`
- `assets/halos/halo-system.svg`
- `assets/halos/radial-seal.svg`
- `assets/wings/feather-fan.svg`
- `assets/architecture/rose-window-arch.svg`
- `assets/geometry/coordinate-geometry.svg`
- `assets/inscriptions/ritual-markers.svg`
- `assets/compositions/*.svg`
- `qml/SacredMotifLayer.qml`、预览页与文档

## 官方参考边界

Bilibili PV 与《明日方舟》/「众生行记」仅作为设计研究参考。当前没有把官方视频文件或官方美术原图打包进来。视频页面在本次检索中可读取到标题、发布日期和简介，但无法稳定逐帧读取，因此请勿把本包表述为官方素材提取或官方画面的一比一复刻。正式分发时仍需保留项目所包含第三方资产的来源/许可说明。


## 新增 PV 关键帧研究附件（v1.1）

- `preview/PV-KEYFRAME-STUDY.jpg`：由用户上传的视频在若干时间码抽取的缩略帧组成的研究联系表，供这次设计分析对照使用；它不是原创纹样、不是官方可复用素材，也不应直接放进 Stronghold 运行包。对外发布应用时建议仅保留分析文档与原创 SVG，按需从发布物中排除此联系表。
- `docs/VIDEO_FRAME_ANALYSIS.md`：以时间码记录观察结论，不含 PV 视频本体或完整分辨率画面。
