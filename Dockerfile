FROM amd64/node:20

ENV DEBIAN_FRONTEND noninteractive

RUN echo "deb http://deb.debian.org/debian bookworm contrib" > /etc/apt/sources.list \
     # && echo "deb http://security.debian.org/ bookworm/updates main contrib" >> /etc/apt/sources.list \
     && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
     && apt-get update \
     && apt-get install -yq --no-install-recommends \ 
          ttf-mscorefonts-installer fontconfig fonts-noto fonts-dejavu fonts-liberation \
          libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 \ 
          libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 \ 
          libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \ 
          libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \ 
          libnss3 \
     && apt-get clean \
     && apt-get autoremove -y \
     && rm -rf /var/lib/apt/lists/* \
     && fc-cache -f

RUN useradd -u 8877 fury
RUN mkdir -p /home/fury
RUN chown fury /home/fury

USER fury
WORKDIR /home/fury
COPY --chown=fury package*.json ./
COPY --chown=fury .fonts.conf ./

RUN npm ci

COPY . .

EXPOSE 3000
CMD [ "npm", "start" ]