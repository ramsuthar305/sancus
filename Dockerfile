# Use the official Node.js LTS (Long Term Support) image
FROM node:18

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the container
COPY package*.json ./

# Install all dependencies, including devDependencies
RUN npm install

# Copy the rest of the application code to the container
COPY . .

# Build the TypeScript code
RUN npm run build

# Remove devDependencies after the build step
RUN npm prune --production

# Expose the port your app will run on
EXPOSE 3000

ENV NODE_ENV=production
# ENV NEW_RELIC_LICENSE_KEY=b229e19d74ca3657e7d9e2dac6c60f9dFFFFNRAL
# ENV NEW_RELIC_APP_NAME=sancus
# ENV NEW_RELIC_LOG_LEVEL=info

# Command to run the application
# CMD ["node", "-r", "newrelic", "build/index.js"]

CMD ["node", "build/index.js"]

