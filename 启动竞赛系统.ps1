# 国防知识竞赛系统 - 启动脚本
# 右键 → 使用 PowerShell 运行，或直接双击

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   国防知识竞赛系统" -ForegroundColor Yellow
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# ========== 配置区 ==========
# 抢答器控制器路径（不用就留空）
$BuzzerExe = "C:\Bupin\Responder\ResponderStd\3.0.0\Hook\ResponderControllerV3.exe"

# 服务端口
$Port = 3000

# 自动打开浏览器
$AutoOpenBrowser = $true

# ==============================

# 1. 启动抢答器控制器
if ($BuzzerExe -ne "") {
    if (Test-Path $BuzzerExe) {
        Write-Host "[1/3] 启动抢答器控制器..." -ForegroundColor Green
        Start-Process $BuzzerExe
    } else {
        Write-Host "[1/3] 警告：未找到抢答器控制器 $BuzzerExe" -ForegroundColor Yellow
    }
} else {
    Write-Host "[1/3] 跳过：未配置抢答器控制器" -ForegroundColor Gray
}

# 2. 启动 Node.js 服务
Write-Host "[2/3] 启动竞赛服务..." -ForegroundColor Green
$serverProcess = Start-Process cmd -ArgumentList "/k node server.js" -PassThru -WindowStyle Normal

# 3. 等待服务启动
Start-Sleep -Seconds 2

# 4. 打开浏览器
if ($AutoOpenBrowser) {
    Write-Host "[3/3] 打开管理端和展示端..." -ForegroundColor Green
    Start-Process "http://localhost:$Port/admin.html"
    Start-Process "http://localhost:$Port/display.html"
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  系统已启动！" -ForegroundColor Green
Write-Host "  管理端: http://localhost:$Port/admin.html" -ForegroundColor White
Write-Host "  展示端: http://localhost:$Port/display.html" -ForegroundColor White
Write-Host ""
Write-Host "  提示：关闭此窗口不会停止服务" -ForegroundColor Gray
Write-Host "  要停止服务，请关闭服务窗口" -ForegroundColor Gray
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "按回车键退出（服务会继续运行）"
