# Tạo file WAV hội thoại tiếng Anh 2 giọng (Windows TTS) dùng làm micro giả lập khi kiểm thử trình duyệt.
param([string]$Out = "$PSScriptRoot\fixtures\meeting-sample.wav")
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out, $fmt)
$ssml = @"
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <break time="1500ms"/>
  <voice name="Microsoft David Desktop">We need to finish the electrical design before Friday.</voice>
  <break time="1800ms"/>
  <voice name="Microsoft Zira Desktop">I agree. We also need to check the cable tray dimensions.</voice>
  <break time="1800ms"/>
  <voice name="Microsoft David Desktop">Can you send the updated drawings tomorrow?</voice>
  <break time="2500ms"/>
</speak>
"@
$s.SpeakSsml($ssml)
$s.Dispose()
Write-Output "Wrote $Out"
