import sys,os
from PIL import Image
n=0
for path in [l.strip() for l in open(sys.argv[1]) if l.strip()]:
    if not os.path.exists(path): continue
    im=Image.open(path).convert('RGBA'); bg=Image.new('RGB',im.size,'white'); bg.paste(im,mask=im.split()[3])
    bg.save(os.path.splitext(path)[0]+'.jpg','JPEG',quality=90); os.remove(path); n+=1
print(f"Converted {n} PNG(s) to JPEG")
