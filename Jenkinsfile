pipeline {
    agent any

    environment {
        SERVER = "car_24@100.126.182.3"
        APP_DIR = "/var/www/car24_backend"
    }

    stages {
        stage('Deploy via SSH') {
            steps {
                sshagent(['server-ssh']) {
                    sh '''
                    ssh -o StrictHostKeyChecking=no $SERVER "
                        cd $APP_DIR &&

                        echo 'Saving current commit...' &&
                        git rev-parse HEAD > last_commit.txt &&

                        echo 'Pulling latest code...' &&
                        git fetch origin main &&
                        git reset --hard origin/main &&

                        echo 'Deploying with Docker...' &&
                        docker compose up -d --build
                    "
                    '''
                }
            }
        }
    }

    post {

        success {
            echo "Deployment Successful 🚀"

            emailext(
                subject: "✅ Deployment SUCCESS - Car24",
                body: "Your latest deployment was successful 🚀",
                to: "team_r.d@stackenzo.com"
            )
        }

        failure {
            echo "Deployment Failed ❌ — Rolling back..."

            sshagent(['server-ssh']) {
                sh '''
                ssh -o StrictHostKeyChecking=no $SERVER "
                    cd $APP_DIR &&

                    echo 'Rolling back to previous commit...' &&
                    git reset --hard \$(cat last_commit.txt) &&

                    docker compose up -d --build
                "
                '''
            }

            emailext(
                subject: "❌ Deployment FAILED - Car24 (Rollback Done)",
                body: "Deployment failed. System rolled back to previous stable version.",
                to: "team_r.d@stackenzo.com"
            )
        }
    }
}