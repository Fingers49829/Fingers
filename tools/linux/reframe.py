# Python port of tools/reframe-images.ps1 (same rules): trims a thin green (Folkcraft), dark-red
# (DulcimerDownloads) or old site-blue frame off store images; leaves frameless images alone.
import sys
from PIL import Image
BLUE=(0x1f,0x4e,0x79)
def ring(px,w,h,d):
    e=d+5; P=[];I=[]
    for x in range(e,w-e,4):
        P.append(px[x,d]); I.append(px[x,e]); P.append(px[x,h-1-d]); I.append(px[x,h-1-e])
    for y in range(e,h-e,4):
        P.append(px[d,y]); I.append(px[e,y]); P.append(px[w-1-d,y]); I.append(px[w-1-e,y])
    return P,I
def frame_kind(P,I):
    n=len(P); g=r=0
    for p,q in zip(P,I):
        pg=p[1]-max(p[0],p[2]); qg=q[1]-max(q[0],q[2]); pr=p[0]-max(p[1],p[2]); qr=q[0]-max(q[1],q[2])
        if pg>=6 or (pg-qg>=25 and pg>-90): g+=1
        if (pr>=25 and p[0]<170) or (pr-qr>=25 and p[0]<170): r+=1
    if g>=0.8*n: return 'green'
    if r>=0.8*n: return 'red'
    return None
def ring_kind(P,I):
    b=sum(1 for p in P if all(abs(p[k]-BLUE[k])<=30 for k in range(3)))
    if b>=0.8*len(P): return 'blue'
    return frame_kind(P,I)
changed=skipped=0
for path in [l.strip() for l in open(sys.argv[1]) if l.strip()]:
    im=Image.open(path); fmt=im.format; im=im.convert('RGB'); w,h=im.size; px=im.load()
    kind=ring_kind(*ring(px,w,h,0))
    if not kind: skipped+=1; continue
    depth=1
    while depth<8 and ring_kind(*ring(px,w,h,depth))==kind: depth+=1
    far=depth+1 if kind=='blue' else depth
    out=im.crop((depth,depth,w-far,h-far))
    if path.lower().endswith('.png'): out.save(path,'PNG')
    else: out.save(path,'JPEG',quality=92)
    changed+=1
print(f"Trimmed the frame off {changed} image(s); left {skipped} unchanged")
