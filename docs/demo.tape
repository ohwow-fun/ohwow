# VHS tape for ohwow demo GIF
# https://github.com/charmbracelet/vhs
# Usage: vhs docs/demo.tape

Output docs/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 800
Set Framerate 24
Set Theme "Catppuccin Mocha"
Set Padding 16
Set CursorBlink false

Hide
Type "clear && bash docs/demo-sim.sh"
Enter
Sleep 1s
Show
Sleep 27s
