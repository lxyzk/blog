---
title: Debian配置SpaceVim
date: 2020-03-31 14:22:32
tags: 
- Debian
- Vim
- +lua
categories: 
- Vi
---

## 配置NeoVim
NeoVim提供了"AppImage"形式的安装包，我们直接使用"AppImage"包，避免繁琐的依赖安装或编译。

<!-- more -->

#### 下载NeoVim


```shell
curl -LO https://github.com/neovim/neovim/releases/download/stable/nvim.appimage
chmod u+x nvim.appimage
```


#### 运行Neovim


```shell
./nvim.appimage
```


如此，NeoVim安装完成


## 配置SpaceVim
执行以下代码：
```shell
curl -sLf https://spacevim.org/install.sh | bash
```


等到安装完成，再次运行


```shell
./nvim.appimage
```


再等待插件下载完成就配置完毕了
