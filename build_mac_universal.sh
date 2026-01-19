#!/bin/bash

# 遇到错误立即退出
set -e

echo "🚀 开始构建 macOS 通用应用 (Universal DMG)..."

# 1. 检查并添加 Rust 目标架构 (支持 M1/M2 和 Intel)
echo "📦 检查 Rust targets..."
if ! rustup target list --installed | grep -q "aarch64-apple-darwin"; then
    echo "   Installing aarch64-apple-darwin..."
    rustup target add aarch64-apple-darwin
fi

if ! rustup target list --installed | grep -q "x86_64-apple-darwin"; then
    echo "   Installing x86_64-apple-darwin..."
    rustup target add x86_64-apple-darwin
fi

# 2. 执行构建命令
echo "🔨 正在编译 (这可能需要几分钟)..."
# 使用 pnpm 执行 tauri build，指定 universal target
pnpm tauri build --target universal-apple-darwin

# 3. 定位输出目录
# 通用构建的输出路径通常在 target/universal-apple-darwin/release/bundle/dmg
DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
APP_DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"

echo "---------------------------------------------------"
if [ -d "$DMG_DIR" ]; then
    FULL_PATH="$(pwd)/$DMG_DIR"
    echo "✅ 构建成功!"
    echo "📂 DMG 文件位置: $FULL_PATH"

    # 列出生成的 DMG 文件
    ls -lh "$DMG_DIR"/*.dmg

    # 自动打开输出目录
    open "$DMG_DIR"
elif [ -d "$APP_DIR" ]; then
    # 如果没有生成 DMG 但生成了 .app (可能是配置问题)
    FULL_PATH="$(pwd)/$APP_DIR"
    echo "⚠️  未找到 DMG 目录，但发现了 .app 目录"
    echo "📂 App 位置: $FULL_PATH"
    open "$APP_DIR"
else
    echo "❌ 构建似乎完成了，但未找到预期的输出目录: $DMG_DIR"
    echo "请检查 src-tauri/target 目录下的构建产物。"
fi
echo "---------------------------------------------------"
