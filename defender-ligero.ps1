<#
.SYNOPSIS
  Reduce el consumo de CPU/RAM de Microsoft Defender sin apagar la proteccion en tiempo real.

.USO (PowerShell como Administrador)
  .\defender-ligero.ps1              # aplica el perfil ligero
  .\defender-ligero.ps1 -Agresivo    # ademas no escanea dentro de archivos comprimidos
  .\defender-ligero.ps1 -Restaurar   # vuelve a los valores por defecto

  Si no te deja ejecutar scripts:
  powershell -ExecutionPolicy Bypass -File .\defender-ligero.ps1
#>

param(
    [switch]$Agresivo,
    [switch]$Restaurar
)

# --- Requiere administrador ---
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) {
    Write-Host "Ejecuta este script como Administrador." -ForegroundColor Red
    exit 1
}

try {
    if ($Restaurar) {
        Set-MpPreference -ScanAvgCPULoadFactor 50 `
                         -EnableLowCpuPriority $false `
                         -ScanOnlyIfIdleEnabled $true `
                         -DisableArchiveScanning $false `
                         -ScanScheduleDay 0
        Write-Host "Valores por defecto restaurados." -ForegroundColor Green
    }
    else {
        # Maximo de CPU que usa durante un escaneo (por defecto 50%)
        Set-MpPreference -ScanAvgCPULoadFactor 15

        # Los escaneos corren con prioridad baja
        Set-MpPreference -EnableLowCpuPriority $true

        # Solo escanea cuando el equipo esta inactivo
        Set-MpPreference -ScanOnlyIfIdleEnabled $true

        # Sin escaneo completo programado (el tiempo real sigue activo)
        Set-MpPreference -ScanScheduleDay 8

        # Un escaneo rapido diario, a la 1:00 p. m., solo si hay inactividad
        Set-MpPreference -ScanScheduleQuickScanTime ([datetime]::Today.AddHours(13))

        # No crear puntos de restauracion antes de limpiar
        Set-MpPreference -DisableRestorePoint $true

        if ($Agresivo) {
            # Menos RAM/CPU al no abrir ZIP/RAR en los escaneos (menos seguro)
            Set-MpPreference -DisableArchiveScanning $true
        }

        Write-Host "Perfil ligero aplicado." -ForegroundColor Green
    }

    Write-Host "`nConfiguracion actual:" -ForegroundColor Cyan
    Get-MpPreference | Select-Object ScanAvgCPULoadFactor, EnableLowCpuPriority,
        ScanOnlyIfIdleEnabled, ScanScheduleDay, ScanScheduleQuickScanTime,
        DisableArchiveScanning, DisableRealtimeMonitoring | Format-List
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Si dice 'Acceso denegado', desactiva temporalmente la Proteccion contra alteraciones (Tamper Protection) en Seguridad de Windows > Proteccion antivirus y contra amenazas > Configuracion." -ForegroundColor Yellow
    exit 1
}
