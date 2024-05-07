FROM amd64/node:20-slim

ENV DEBIAN_FRONTEND noninteractive
ENV LANG en_US.UTF-8

RUN echo "deb http://deb.debian.org/debian bookworm contrib" > /etc/apt/sources.list \
     && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
     && apt-get update \
     && apt-get install -y wget gnupg \
     && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
     && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] https://dl-ssl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
     && apt-get update \
     && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 dbus dbus-x11 ttf-mscorefonts-installer fontconfig fonts-noto fonts-dejavu fonts-liberation --no-install-recommends \
     && rm -rf /var/lib/apt/lists/* /opt/google \
     && fc-cache -f

RUN useradd -u 8877 fury
RUN mkdir -p /home/fury
RUN chown fury /home/fury

USER fury
WORKDIR /home/fury
COPY --chown=fury package*.json ./
COPY --chown=fury .fonts.conf ./

ENV DBUS_SESSION_BUS_ADDRESS autolaunch:

RUN npm ci

COPY . .

EXPOSE 3000
CMD [ "npm", "start" ]