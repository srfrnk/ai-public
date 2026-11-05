rm  -rf ~/.bantha/data
rm -rf /tmp/ttt
mkdir /tmp/ttt
cd /tmp/ttt
bantha hermes chat --cli --yolo -q "$(cat /mnt/data/code/ai-public/bantha/tests/ctf/goal.md)"
