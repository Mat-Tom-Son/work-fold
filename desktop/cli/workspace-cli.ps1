Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$pathManagementFlag = '--workspace-installer-manage-user-path'
if ($args.Count -gt 0 -and [string]$args[0] -ceq $pathManagementFlag) {
  try {
    if ($args.Count -ne 3 -or @('install', 'uninstall') -notcontains [string]$args[1]) {
      throw 'Invalid installer PATH management request.'
    }
    $action = [string]$args[1]
    $target = ([string]$args[2]).Trim().TrimEnd('\')
    if ([string]::IsNullOrWhiteSpace($target)) {
      throw 'The installer CLI bin path is empty.'
    }
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $registryKey -and $action -eq 'install') {
      $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    }
    if ($null -eq $registryKey) {
      exit 0
    }
    try {
      $currentValue = $registryKey.GetValue(
        'Path',
        '',
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
      $currentPath = if ($null -eq $currentValue) { '' } else { [string]$currentValue }
      $matchesTarget = {
        param([string]$entry)
        [string]::Equals($entry.Trim().TrimEnd('\'), $target, [StringComparison]::OrdinalIgnoreCase)
      }
      if ($action -eq 'install') {
        if ($currentPath.Split(';') | Where-Object { & $matchesTarget $_ }) {
          exit 0
        }
        $nextPath = if ([string]::IsNullOrEmpty($currentPath)) {
          $target
        } elseif ($currentPath.EndsWith(';', [StringComparison]::Ordinal)) {
          "$currentPath$target"
        } else {
          "$currentPath;$target"
        }
        $registryKey.SetValue('Path', $nextPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      } else {
        $removed = $false
        $keptEntries = [Collections.Generic.List[string]]::new()
        foreach ($entry in $currentPath.Split(';')) {
          if (& $matchesTarget $entry) {
            $removed = $true
          } else {
            $keptEntries.Add($entry)
          }
        }
        if (-not $removed) {
          exit 0
        }
        $nextPath = [string]::Join(';', $keptEntries)
        if ([string]::IsNullOrEmpty($nextPath)) {
          $registryKey.DeleteValue('Path', $false)
        } else {
          $registryKey.SetValue('Path', $nextPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        }
      }
    } finally {
      $registryKey.Dispose()
    }
    exit 0
  } catch {
    [Console]::Error.Write("workspace installer: $($_.Exception.Message)$([Environment]::NewLine)")
    exit 1
  }
}

$script:ActUnavailableMessage = 'Open Workspace to run this command. Chat, Check, and Space actions need the Workspace app running.'
$script:ActMaxMessageFileBytes = 262144

function Test-WorkspaceActCommand {
  param([string[]]$CommandArguments)
  $positional = @($CommandArguments | Where-Object { $_ -cne '--json' })
  $group = if ($positional.Count -gt 0) { [string]$positional[0] } else { '' }
  if (@('chat', 'chats', 'files', 'manage') -contains $group) { return $true }
  if ($group -ceq 'checks') { return $positional.Count -lt 2 -or [string]$positional[1] -cne 'status' }
  if ($group -ceq 'spaces' -and $positional.Count -gt 1 -and @('create', 'register') -contains [string]$positional[1]) { return $true }
  return $false
}

function Read-WorkspaceActToken {
  param([string]$CliRoot)
  $tokenPath = Join-Path $CliRoot 'act-token.json'
  if (-not [IO.File]::Exists($tokenPath)) { return $null }
  try {
    $record = [IO.File]::ReadAllText($tokenPath, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    if ($record.version -ne 1) { return $null }
    $token = [string]$record.actToken
    if ($token -notmatch '^[A-Za-z0-9_-]{16,256}$') { return $null }
    return $token
  } catch {
    return $null
  }
}

function Invoke-WorkspaceRequest {
  param(
    [string[]]$RequestArguments,
    [string]$ActToken,
    [object]$Payload
  )
  $requestId = [Guid]::NewGuid().ToString('D')
  $requestDirectory = Join-Path $script:WorkspaceCliRoot 'requests'
  $responseDirectory = Join-Path $script:WorkspaceCliRoot 'responses'
  $requestPath = Join-Path $requestDirectory "$requestId.json"
  $responsePath = Join-Path $responseDirectory "$requestId.json"
  $temporaryRequestPath = Join-Path $requestDirectory "$requestId.$([Guid]::NewGuid().ToString('D')).tmp"
  try {
    if ([string]::IsNullOrEmpty($ActToken)) {
      $request = [ordered]@{
        protocolVersion = 1
        id = $requestId
        argv = $RequestArguments
        cwd = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
        createdAt = [DateTimeOffset]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
      }
    } else {
      $request = [ordered]@{
        protocolVersion = 2
        lane = 'act'
        id = $requestId
        argv = $RequestArguments
        cwd = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
        createdAt = [DateTimeOffset]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        actToken = $ActToken
      }
      if ($null -ne $Payload) {
        $request['payload'] = $Payload
      }
    }
    $requestJson = $request | ConvertTo-Json -Compress -Depth 6
    $requestBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($requestJson)
    $requestStream = [IO.FileStream]::new(
      $temporaryRequestPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try {
      $requestStream.Write($requestBytes, 0, $requestBytes.Length)
      $requestStream.Flush($true)
    } finally {
      $requestStream.Dispose()
    }
    [IO.File]::Move($temporaryRequestPath, $requestPath)
    $temporaryRequestPath = $null

    Start-Process -FilePath $script:WorkspaceAppPath -ArgumentList @('--workspace-cli-request', $requestId) -WindowStyle Hidden | Out-Null

    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($responsePath)) {
      if ($timer.ElapsedMilliseconds -ge $script:WorkspaceCliTimeoutMs) {
        throw [TimeoutException]::new("Workspace did not answer CLI request $requestId within $($script:WorkspaceCliTimeoutMs) ms.")
      }
      Start-Sleep -Milliseconds 50
    }

    $response = [IO.File]::ReadAllText($responsePath, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    if ($response.protocolVersion -ne 1) {
      throw "Workspace returned unsupported CLI protocol version $($response.protocolVersion)."
    }
    if ([string]$response.id -cne $requestId) {
      throw 'Workspace returned a CLI response with the wrong request id.'
    }
    return [pscustomobject]@{
      ExitCode = [Convert]::ToInt32($response.exitCode, [Globalization.CultureInfo]::InvariantCulture)
      Stdout = [string]$response.stdout
      Stderr = [string]$response.stderr
    }
  } finally {
    foreach ($path in @($temporaryRequestPath, $requestPath, $responsePath)) {
      if (-not [string]::IsNullOrWhiteSpace($path) -and [IO.File]::Exists($path)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function ConvertTo-WorkspaceActArguments {
  # Rewrites --message-file <path> into a bounded payload the host can trust.
  param([string[]]$CommandArguments)
  $rewritten = [Collections.Generic.List[string]]::new()
  $payload = $null
  for ($index = 0; $index -lt $CommandArguments.Count; $index += 1) {
    $token = [string]$CommandArguments[$index]
    if ($token -cne '--message-file') {
      $rewritten.Add($token)
      continue
    }
    if ($index + 1 -ge $CommandArguments.Count) {
      throw New-WorkspaceUsageError '--message-file requires a path.'
    }
    if ($null -ne $payload) {
      throw New-WorkspaceUsageError '--message-file may be provided only once.'
    }
    $messagePath = [IO.Path]::GetFullPath([string]$CommandArguments[$index + 1])
    $index += 1
    $messageText = [IO.File]::ReadAllText($messagePath, [System.Text.UTF8Encoding]::new($false))
    if ([System.Text.UTF8Encoding]::new($false).GetByteCount($messageText) -gt $script:ActMaxMessageFileBytes) {
      throw New-WorkspaceUsageError "--message-file exceeds $($script:ActMaxMessageFileBytes) bytes."
    }
    $payload = [ordered]@{ messageFile = $messageText }
    $rewritten.Add('--message-from-payload')
  }
  return [pscustomobject]@{ Arguments = $rewritten.ToArray(); Payload = $payload }
}

function Get-WorkspaceChatWaitPlan {
  param([string[]]$CommandArguments)
  $positional = @($CommandArguments | Where-Object { $_ -cne '--json' })
  if ($positional.Count -lt 2 -or $positional[1] -cne 'wait') { return $null }
  $group = [string]$positional[0]
  if (@('chat', 'manage', 'checks') -notcontains $group) { return $null }
  $plan = [ordered]@{ Group = $group; Space = ''; Task = ''; TimeoutSeconds = 600; Json = $CommandArguments -ccontains '--json' }
  for ($index = 0; $index -lt $CommandArguments.Count; $index += 1) {
    $token = [string]$CommandArguments[$index]
    switch ($token) {
      '--space' { $plan.Space = [string]$CommandArguments[$index + 1]; $index += 1 }
      '--task' { $plan.Task = [string]$CommandArguments[$index + 1]; $index += 1 }
      '--timeout' {
        $timeoutSeconds = 0
        if (-not [int]::TryParse([string]$CommandArguments[$index + 1], [ref]$timeoutSeconds) -or $timeoutSeconds -lt 1 -or $timeoutSeconds -gt 3600) {
          throw New-WorkspaceUsageError '--timeout must be an integer between 1 and 3600 seconds.'
        }
        $plan.TimeoutSeconds = $timeoutSeconds
        $index += 1
      }
      $group { }
      'wait' { }
      '--json' { }
      default { throw New-WorkspaceUsageError "Unknown option for $group wait: $token" }
    }
  }
  if ((@('chat', 'checks') -contains $group) -and [string]::IsNullOrWhiteSpace($plan.Space)) { throw New-WorkspaceUsageError 'Act commands require an explicit --space <id-or-name>.' }
  if ($group -ceq 'manage' -and -not [string]::IsNullOrWhiteSpace($plan.Space)) { throw New-WorkspaceUsageError 'The management scope does not take --space.' }
  if ([string]::IsNullOrWhiteSpace($plan.Task)) {
    $source = if ($group -ceq 'checks') { 'checks run' } else { "$group send" }
    throw New-WorkspaceUsageError "Provide --task <id> from $source."
  }
  return [pscustomobject]$plan
}

function Invoke-WorkspaceChatWait {
  param([pscustomobject]$Plan, [string]$ActToken)
  # Waiting is task-scoped: it follows the exact turn the send accepted, so
  # an older assistant message can never read as this turn's success.
  $statusArguments = [Collections.Generic.List[string]]::new()
  $statusVerb = if ($Plan.Group -ceq 'checks') { 'task' } else { 'status' }
  $statusArguments.AddRange([string[]]@($Plan.Group, $statusVerb))
  if ((@('chat', 'checks') -contains $Plan.Group)) { $statusArguments.AddRange([string[]]@('--space', $Plan.Space)) }
  $statusArguments.AddRange([string[]]@('--task', $Plan.Task, '--json'))
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Plan.TimeoutSeconds)
  for (;;) {
    $status = Invoke-WorkspaceRequest -RequestArguments $statusArguments.ToArray() -ActToken $ActToken -Payload $null
    if ($status.ExitCode -ne 0) {
      Write-WorkspaceOutcome $status
      return $status.ExitCode
    }
    $state = ''
    try {
      $state = [string](($status.Stdout | ConvertFrom-Json).data.task.state)
    } catch {
      throw 'Workspace returned an unreadable task status.'
    }
    if (@('accepted', 'running') -notcontains $state) { break }
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      [Console]::Error.Write("workspace: $($Plan.Group) wait timed out after $($Plan.TimeoutSeconds)s.$([Environment]::NewLine)")
      return 7
    }
    Start-Sleep -Seconds 2
  }
  $resultArguments = [Collections.Generic.List[string]]::new()
  $resultArguments.AddRange([string[]]@($Plan.Group, 'result'))
  if ((@('chat', 'checks') -contains $Plan.Group)) { $resultArguments.AddRange([string[]]@('--space', $Plan.Space)) }
  $resultArguments.AddRange([string[]]@('--task', $Plan.Task))
  if ($Plan.Json) { $resultArguments.Add('--json') }
  $result = Invoke-WorkspaceRequest -RequestArguments $resultArguments.ToArray() -ActToken $ActToken -Payload $null
  Write-WorkspaceOutcome $result
  return $result.ExitCode
}

function Write-WorkspaceOutcome {
  param([pscustomobject]$Outcome)
  [Console]::Out.Write([string]$Outcome.Stdout)
  [Console]::Error.Write([string]$Outcome.Stderr)
}

function New-WorkspaceUsageError {
  param([string]$Message)
  $usageError = [Exception]::new("$Message`nRun 'workspace help' for usage.")
  $usageError.Data['workspaceExitCode'] = 2
  return $usageError
}

$commandArguments = [string[]]@($args)
$exitCode = 1

try {
  $appData = $env:APPDATA
  if ([string]::IsNullOrWhiteSpace($appData)) {
    $appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  }
  if ([string]::IsNullOrWhiteSpace($appData)) {
    throw 'The current user AppData directory could not be resolved.'
  }

  $appPath = if ([string]::IsNullOrWhiteSpace($env:WORKSPACE_CLI_APP)) {
    Join-Path $PSScriptRoot '..\Workspace.exe'
  } else {
    $env:WORKSPACE_CLI_APP
  }
  $appPath = [IO.Path]::GetFullPath($appPath)
  if (-not [IO.File]::Exists($appPath)) {
    throw "Workspace executable was not found at $appPath."
  }

  $stateDirectory = if ([string]::IsNullOrWhiteSpace($env:WORKSPACE_CLI_STATE_DIR)) {
    $uninstallerPath = Join-Path ([IO.Path]::GetDirectoryName($appPath)) 'Uninstall Workspace.exe'
    $stateName = if ([IO.File]::Exists($uninstallerPath)) { 'Workspace' } else { 'Workspace Development' }
    Join-Path $appData $stateName
  } else {
    $env:WORKSPACE_CLI_STATE_DIR
  }
  $stateDirectory = [IO.Path]::GetFullPath($stateDirectory)

  $timeoutMs = 120000
  if (-not [string]::IsNullOrWhiteSpace($env:WORKSPACE_CLI_TIMEOUT_MS)) {
    $configuredTimeout = 0
    if (-not [int]::TryParse($env:WORKSPACE_CLI_TIMEOUT_MS, [ref]$configuredTimeout) -or $configuredTimeout -lt 100 -or $configuredTimeout -gt 600000) {
      throw 'WORKSPACE_CLI_TIMEOUT_MS must be an integer between 100 and 600000.'
    }
    $timeoutMs = $configuredTimeout
  }

  $script:WorkspaceAppPath = $appPath
  $script:WorkspaceCliRoot = Join-Path $stateDirectory 'cli'
  $script:WorkspaceCliTimeoutMs = $timeoutMs
  [IO.Directory]::CreateDirectory((Join-Path $script:WorkspaceCliRoot 'requests')) | Out-Null
  [IO.Directory]::CreateDirectory((Join-Path $script:WorkspaceCliRoot 'responses')) | Out-Null

  if (Test-WorkspaceActCommand -CommandArguments $commandArguments) {
    # Chat, Space, and file writes ride the separately versioned act lane and
    # require the per-launch token the running app minted.
    $actToken = Read-WorkspaceActToken -CliRoot $script:WorkspaceCliRoot
    if ([string]::IsNullOrEmpty($actToken)) {
      [Console]::Error.Write("workspace: $($script:ActUnavailableMessage)$([Environment]::NewLine)")
      exit 6
    }
    $waitPlan = Get-WorkspaceChatWaitPlan -CommandArguments $commandArguments
    if ($null -ne $waitPlan) {
      $exitCode = Invoke-WorkspaceChatWait -Plan $waitPlan -ActToken $actToken
    } else {
      $prepared = ConvertTo-WorkspaceActArguments -CommandArguments $commandArguments
      $outcome = Invoke-WorkspaceRequest -RequestArguments $prepared.Arguments -ActToken $actToken -Payload $prepared.Payload
      Write-WorkspaceOutcome $outcome
      $exitCode = $outcome.ExitCode
    }
  } else {
    $outcome = Invoke-WorkspaceRequest -RequestArguments $commandArguments -ActToken '' -Payload $null
    Write-WorkspaceOutcome $outcome
    $exitCode = $outcome.ExitCode
  }
} catch [TimeoutException] {
  $exitCode = 124
  [Console]::Error.Write("workspace: $($_.Exception.Message)$([Environment]::NewLine)")
} catch {
  $exitCode = 1
  if ($_.Exception.Data.Contains('workspaceExitCode')) {
    $exitCode = [int]$_.Exception.Data['workspaceExitCode']
  }
  [Console]::Error.Write("workspace: $($_.Exception.Message)$([Environment]::NewLine)")
}

exit $exitCode
