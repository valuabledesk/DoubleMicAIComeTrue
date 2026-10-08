# RV1126B 平台 GDB 使用指南

适用场景：在 RV1126B 板端使用 GDB 分析 `main_app` 的 core dump，定位崩溃线程、调用栈和相关变量。

## 1. 准备文件

建议将调试文件统一放到板端 `/app/sd/`：

```text
/app/sd/
├── gdb
├── main_app_not_stripped
├── libc.so.6
├── libxxx.so                  # 需要分析的其他未裁剪库
└── core-290-main_app           # 实际生成的 core 文件
```

### GDB 工具

SDK 中的参考位置（可能需要先编译）：

```text
RV1126B_Linux_IPC_SDK-IPC/output/out/sysdrv_out/rootfs_glibc_rv1126b/bin/gdb
```

使用适配板端架构和运行环境的 GDB，拷贝后添加执行权限：

```sh
chmod +x /app/sd/gdb
```

### 未裁剪的主程序

`main_app_not_stripped` 的参考目录：

```text
ddp_build/reference/out/rv1126b_dashcam_nonescreen_dz2602_global/bin
```

**优先保留并使用生成故障版本时的原始未裁剪产物。** 主程序和 `.so` 必须与崩溃时使用的二进制匹配；仅 SVN 版本相同，并不能保证不同编译配置或依赖下的产物完全一致。

如需按历史版本重新编译，可在对应源码工作副本中执行以下命令，并保持工具链、编译选项和依赖一致（示例版本号：`40137`）：

```sh
svn up -r 40137
```

### 未裁剪的共享库

`libc.so.6` 的参考位置：

```text
RV1126B_Linux_IPC_SDK-IPC/tools/linux/toolchain/arm-rockchip1240-linux-gnueabihf/arm-rockchip1240-linux-gnueabihf/sysroot/lib/libc.so.6
```

其他 Rockchip 库可在 SVN 以下目录查找：

```text
kunpengv2/ddp_build/library/rockchip/rv1126b
```

发布到板端的库通常经过 `strip` 处理，以减小体积。应将匹配的未裁剪库复制到 SD 卡，保留程序实际依赖的库名，例如 `libc.so.6`；若它是符号链接，要一并提供真实目标文件。

可在编译机上用 `file` 检查文件：

```sh
file main_app_not_stripped
file libc.so.6
```

`not stripped` 表示未裁剪，**不等于一定包含完整调试信息**。要查看源码行号、局部变量等，通常还需要编译时启用 `-g`，并保留调试信息。`file` 输出中的 `with debug_info` 可作为初步判断依据。

## 2. 加载 core：可直接参考的流程

先在板端 Shell 中启动 GDB，直接加载未裁剪的主程序：

```sh
/app/sd/gdb -nx /app/sd/main_app_not_stripped
```

`-nx` 用于跳过 GDB 初始化配置文件，减少已有配置的影响。随后在 GDB 提示符下执行：

```gdb
# 关闭分页，避免输出中途等待按键
set pagination off

# 切换工作目录，避免相对路径 app/lib 命中原来的库
cd /app/sd
pwd

# 使用一个不存在的系统根目录，让共享库绝对路径查找失败后回退搜索
set sysroot /_root__

# 搜索匹配的未裁剪库；缺失时再从板端目录查找其他依赖
set solib-search-path /app/sd:/app/lib:/lib:/usr/lib
set auto-solib-add on

# 加载崩溃现场，按实际文件名修改
core-file /app/sd/core-290-main_app

# 检查共享库加载情况，并查看崩溃线程和所有线程的调用栈
info sharedlibrary
bt
thread apply all bt full
```

说明：

- `/app/sd` 若链接到 `/run/sd`，`pwd` 显示后者也正常。
- `/_root__` 是故意指定的不存在路径，无需创建。此方法用于引导 GDB 从 `solib-search-path` 中查找共享库。
- 重点分析的库应放在 `/app/sd` 中；回退到 `/app/lib`、`/lib` 等目录时，可能加载到裁剪后的库。
- 用 `info sharedlibrary` 检查加载路径和符号状态；显示 `Yes` 也不一定代表具备源码级调试信息，要结合输出注释及实际调试结果判断。

## 3. 常用排查命令

| 命令 | 用途 |
| --- | --- |
| `bt` | 查看当前线程调用栈 |
| `bt full` | 查看调用栈及各栈帧的局部变量 |
| `info threads` | 查看所有线程，`*` 表示当前选中的线程 |
| `thread 3` | 切换到 GDB 线程编号为 3 的线程 |
| `thread apply all bt full` | 查看所有线程的详细调用栈 |
| `frame 2` | 切换到第 2 号栈帧，栈帧从 0 开始 |
| `info args` | 查看当前栈帧的函数参数 |
| `info locals` | 查看当前栈帧的局部变量 |
| `p variable` | 打印变量值，将 `variable` 替换为实际变量名 |
| `p/x variable` | 以十六进制打印变量值 |
| `list` | 查看当前栈帧附近的源码，需要源码文件 |
| `info registers` | 查看当前线程、所选栈帧的寄存器信息 |
| `x/16wx ADDRESS` | 从指定地址读取 16 个四字节单元，以十六进制显示 |
| `quit` | 退出 GDB |

建议排查顺序：先看 GDB 报告的终止信号和 `bt`，再切换到相关业务栈帧，用 `info args`、`info locals`、`p` 检查参数和变量；最后查看其他线程，判断是否涉及并发或共享数据。

core 是崩溃时的静态快照，不能使用 `run`、`continue`、`next` 等命令继续执行其中的程序。

## 4. 保存调试输出

在执行调用栈等排查命令之前开启日志：

```gdb
set logging file /app/sd/gdb_core.log
set logging overwrite on
set logging enabled on

info sharedlibrary
info threads
thread apply all bt full

set logging enabled off
```

较老版本的 GDB 若不支持 `set logging enabled on/off`，可改用 `set logging on` 和 `set logging off`。上述配置会覆盖已有同名日志，需保留历史记录时请换一个文件名。

## 5. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 调用栈中出现 `??` | 对应模块是否缺少符号、文件是否匹配；也可能存在栈损坏 |
| 提示主程序与 core 不匹配 | 是否使用了该故障版本对应的原始主程序产物 |
| 无法加载某个 `.so` | 库名、搜索目录和符号链接目标是否正确，库是否与故障版本匹配 |
| 能看到函数名，但没有行号或局部变量 | 是否保留了 `-g` 生成的调试信息；仅 `not stripped` 不够 |
| 变量显示 `<optimized out>` | 编译优化导致变量无法恢复；后续复现可考虑 `-g -Og` 重新构建 |
| 提示源码文件不存在 | 调试信息中的编译路径在板端不存在，需要提供源码并映射路径 |
| 尚未生成 core 文件 | 检查启动进程时的 `ulimit -c`、`/proc/sys/kernel/core_pattern` 及落盘空间和权限 |

如果已将对应版本的源码放到板端，可按实际路径设置映射：

```gdb
set substitute-path /original/build/source /app/sd/source
```

重新编译的程序只能用于新的复现调试，不能直接拿来替代旧 core 对应的原始二进制。对于服务启动的程序，core 大小限制应在服务的实际启动环境中设置。
