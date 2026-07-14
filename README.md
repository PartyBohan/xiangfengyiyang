# xiangfengyiyang

《像风一样》音乐密码四关练习网页，线上地址：<https://xiangfengyiyang.partykeys.ai>。

项目围绕一首歌生成四个连续 PartyKeys 练习关卡：

1. 完整示范聆听。
2. 卡拉 OK 式和弦跟弹。
3. 根音、五音、右手和弦与琶音织体。
4. 左手伴奏加右手旋律的完整演奏。

## 默认 MusicXML

`public/song.musicxml` 是产品默认加载的《像风一样》双声部曲谱：

- C 调、4/4 拍、60 BPM。
- 高音声部作为旋律，低音声部用于识别 C、Am、F、G、Dm 等和弦。
- 总音域 F2–E6。单台 36 键模式会按声部做八度折叠，双台 72 键模式保留完整音域。
- 原文件没有 MusicXML `lyric` 标签，因此歌词区暂时显示小节提示；页面保留 MusicXML 上传入口，可继续替换为含歌词版本。

## 输入、音色与灯光

- 支持 Web MIDI / MidiBrowser 输入，也支持屏幕虚拟键盘。
- 普通 MIDI 键盘可发声与判定；只有识别为 PartyKeys 的输出才发送专用 SysEx。
- PartyKeys 36 使用 CMD `0x15` RGB、连接后 `0F 01` 初始化、差异更新、停止时全灭；单帧不超过 256 bytes。
- 内置 Salamander Grand Piano V3 的 13 音高 × 4 力度采样，加载前使用合成音色兜底。署名见 [AUDIO_CREDITS.md](AUDIO_CREDITS.md)。

## 36 / 72 键模式

- 单琴：MIDI 48–83（C3–B5）。
- 双琴原型：第一台 PartyKeys 映射为 MIDI 36–71（C2–B4），第二台映射为 72–107（C5–B7）。
- 双琴顺序按浏览器枚举到的 PartyKeys 输入顺序决定。正式发布前仍需在两台真实 PartyKeys 上验证设备顺序、重连与灯光延迟。

## 开发

```bash
pnpm install
pnpm dev
pnpm build
```

本项目部署在 Vercel。MIDI、BLE 和灯光功能必须继续通过真实 PartyKeys 设备验收，浏览器构建通过不等同于硬件发布就绪。

## License

源代码采用 MIT License。钢琴采样遵循 CC BY 3.0；音乐密码品牌与官方产品渲染不包含在 MIT 授权中，详见 [ASSET_NOTICE.md](ASSET_NOTICE.md)。
