本目录的字体全部本地内嵌，运行时不请求任何外部 CDN，断网也能正常显示。

为什么用两套字体
----------------
点阵字体只有在「字号 = 网格尺寸的整数倍」时才不会被插值糊掉，多 0.5px 都会
重新采样出灰边。所以这里按字号分工，各自只在自己的整数倍下使用：

1) chill-bitmap.woff2 —— 标题与关键数字
   寒蝉点阵体（Chill Bitmap 7px）v2.500，作者：寒蝉字型
   来源：npm 包 @fontpkg/chill-bitmap 2.500.1
   网格 7px，只用 14 / 21 / 28px（2× / 3× / 4×）
   授权：以作者发布页为准，对外发布前请确认商用授权

2) fusion-pixel-12/ —— 界面小字（比例版）
3) fusion-pixel-12-mono/ —— 时间、数字、代码（等宽版）
   Fusion Pixel 12px，作者：TakWolf
   来源：npm 包 @vp-tw/cjk-web-fonts-fusion-pixel-font 3.0.0
   网格 12px，只用 12px（1×，一个像素格正好一个屏幕像素）
   授权：SIL Open Font License 1.1，见 Fusion-Pixel-OFL.txt

CSS 里对应 --font-title（寒蝉）、--font-ui（Fusion 比例）、--font-mono（Fusion 等宽）。
换字体时只要改这三个变量和 @font-face 路径，字号标尺不用动。
